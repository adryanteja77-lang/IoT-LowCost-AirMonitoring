// Vercel Function: menerima data dari EMQX (Data Integration > HTTP Server)
// dan menulis ke Firestore. Menggantikan bridge Node.js yang harus hidup terus.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { ispuFromCO, ispuCategory, ppmToUgm3 } from "./_ispu.js";

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
}
const db = getFirestore();

const COLLECTION = process.env.FIRESTORE_COLLECTION || "readings";
const MIN_VALID_HOURS = Number(process.env.MIN_VALID_HOURS || 18); // JANGAN 1 di produksi
const COMPUTE_EVERY_MS = 5 * 60_000; // hitung ulang iAQI maks 1x per 5 menit per node

const inRange = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, "");

async function addToHourly(nodeId, ugm3, isTest) {
  const now = Date.now();
  await db.collection("hourly").doc(`${nodeId}_${hourKey(now)}`).set(
    {
      nodeId,
      hourStart: Timestamp.fromMillis(Math.floor(now / 3600_000) * 3600_000),
      sumUgm3: FieldValue.increment(ugm3),
      count: FieldValue.increment(1),
      testCount: FieldValue.increment(isTest ? 1 : 0),
    },
    { merge: true }
  );
}

async function updateStatus(nodeId) {
  const now = Date.now();
  const statusRef = db.collection("status").doc(nodeId);
  const prev = await statusRef.get();
  const prevAt = prev.exists ? prev.data().updatedAt?.toMillis?.() : 0;
  if (prevAt && now - prevAt < COMPUTE_EVERY_MS) return;

  const refs = Array.from({ length: 24 }, (_, h) =>
    db.collection("hourly").doc(`${nodeId}_${hourKey(now - h * 3600_000)}`)
  );
  const snaps = await db.getAll(...refs);

  let validHours = 0, sumOfHourlyAvg = 0, anyTest = false;
  for (const s of snaps) {
    if (!s.exists) continue;
    const { sumUgm3, count, testCount } = s.data();
    if (!count) continue;
    validHours += 1;
    sumOfHourlyAvg += sumUgm3 / count;
    if (testCount > 0) anyTest = true;
  }

  const enough = validHours >= MIN_VALID_HOURS;
  const avg = validHours ? sumOfHourlyAvg / validHours : null;
  const iaqi = enough ? ispuFromCO(avg) : null;

  await statusRef.set({
    nodeId,
    validHours,
    enough,
    avgCoUgm3: avg,
    iaqi,
    category: ispuCategory(iaqi),
    test: anyTest,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.INGEST_SECRET || req.headers["x-api-key"] !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // Body dari EMQX: {"topic":"bali-airwatch/node-01/data","payload":{...}}
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  let d = body.payload;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch { return res.status(400).json({ error: "payload bukan JSON" }); } }
  const nodeId = String(body.topic || "").split("/")[1];
  if (!nodeId || !d) return res.status(400).json({ error: "topic/payload kosong" });
  if (d.nodeId && d.nodeId !== nodeId) return res.status(400).json({ error: "nodeId tidak cocok dengan topic" });
  if (!inRange(d.temp, -40, 80) || !inRange(d.humidity, 0, 100) || !inRange(d.co, 0, 1000)) {
    return res.status(400).json({ error: "nilai di luar rentang" });
  }

  const isTest = d.test === true;
  const coUgm3 = ppmToUgm3(d.co, d.temp);

  try {
    await db.collection(COLLECTION).add({
      nodeId, temp: d.temp, humidity: d.humidity, co: d.co, coUgm3,
      test: isTest, createdAt: FieldValue.serverTimestamp(),
    });
    await addToHourly(nodeId, coUgm3, isTest);
    await updateStatus(nodeId);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Gagal tulis Firestore:", e.message);
    return res.status(500).json({ error: "firestore" });
  }
}
// Vercel Function: menerima data dari EMQX (Data Integration > HTTP Server)
// dan menulis ke Firestore.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { ispuFromCO, ispuCategory, ppmToUgm3 } from "./_ispu.js";
import { compensate } from "./_comp.js";

if (!getApps().length) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
}
const db = getFirestore();

const COLLECTION = process.env.FIRESTORE_COLLECTION || "readings";
const MIN_VALID_HOURS = Number(process.env.MIN_VALID_HOURS || 18); // JANGAN 1 di produksi
const COMPUTE_EVERY_MS = 5 * 60_000; // hitung ulang iAQI maks 1x per 5 menit per node

const inRange = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, "");

// envCount = jumlah pembacaan yang ikut dijumlahkan di sumPpm/sumTemp/sumHum/sumRs.
// sumUgm3  = dasar iAQI (terkoreksi jika node divalidasi, selain itu mentah).
// sumUgm3Raw selalu mentah; compCount/sumPpmComp hanya jika koreksi tersedia.
async function addToHourly(nodeId, d, ugm3Used, ugm3Raw, comp, isTest) {
  const now = Date.now();
  const upd = {
    nodeId,
    hourStart: Timestamp.fromMillis(Math.floor(now / 3600_000) * 3600_000),
    sumUgm3: FieldValue.increment(ugm3Used),
    sumUgm3Raw: FieldValue.increment(ugm3Raw),
    count: FieldValue.increment(1),
    testCount: FieldValue.increment(isTest ? 1 : 0),
    sumPpm: FieldValue.increment(d.co),
    sumTemp: FieldValue.increment(d.temp),
    sumHum: FieldValue.increment(d.humidity),
    envCount: FieldValue.increment(1),
  };
  if (comp.rs) { upd.sumRs = FieldValue.increment(comp.rs); upd.rsCount = FieldValue.increment(1); }
  if (comp.coComp !== null) { upd.sumPpmComp = FieldValue.increment(comp.coComp); upd.compCount = FieldValue.increment(1); }
  await db.collection("hourly").doc(`${nodeId}_${hourKey(now)}`).set(upd, { merge: true });
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

  // Riwayat iAQI: satu dokumen per node per jam (nilai terakhir di jam itu).
  await db.collection("iaqi_log").doc(`${nodeId}_${hourKey(now)}`).set({
    nodeId,
    hourStart: Timestamp.fromMillis(Math.floor(now / 3600_000) * 3600_000),
    iaqi, // null jika data belum cukup
    avgCoUgm3: avg,
    validHours,
    enough,
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
  if (d.rs !== undefined && !inRange(d.rs, 0, 1e7)) delete d.rs; // rs ngaco -> abaikan, jangan tolak data

  const isTest = d.test === true;
  // warmup:true = disimpan dan ditampilkan, tetapi TIDAK masuk rata-rata per jam / iAQI.
  const isWarmup = d.warmup === true;

  const comp = compensate(nodeId, d);
  const coUgmRaw = ppmToUgm3(d.co, d.temp);
  const coUgmComp = comp.coComp !== null ? ppmToUgm3(comp.coComp, d.temp) : null;
  const coUgmUsed = comp.useComp && coUgmComp !== null ? coUgmComp : coUgmRaw;

  try {
    await db.collection(COLLECTION).add({
      nodeId, temp: d.temp, humidity: d.humidity,
      co: d.co,                       // ppm mentah
      coUgm3: coUgmRaw,               // tetap mentah, kompatibel dengan dashboard lama
      rs: comp.rs ?? null,
      coComp: comp.coComp,            // ppm terkoreksi (null jika belum ada koefisien)
      coCompUgm3: coUgmComp,
      compUsed: comp.useComp,         // true = iAQI memakai nilai terkoreksi
      test: isTest, warmup: isWarmup, createdAt: FieldValue.serverTimestamp(),
    });
    if (!isWarmup) {
      await addToHourly(nodeId, d, coUgmUsed, coUgmRaw, comp, isTest);
      await updateStatus(nodeId);
    }
    return res.status(200).json({ ok: true, warmup: isWarmup, comp: comp.coComp !== null });
  } catch (e) {
    console.error("Gagal tulis Firestore:", e.message);
    return res.status(500).json({ error: "firestore" });
  }
}
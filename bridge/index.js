import "dotenv/config";
import fs from "node:fs";
import mqtt from "mqtt";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { ispuFromCO, ispuCategory, ppmToUgm3 } from "./ispu.js";

const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, "utf8"));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const COLLECTION = process.env.FIRESTORE_COLLECTION || "readings";
// Pasal 7 ayat 3: data valid minimal 75% dari 24 jam = 18 jam.
// Untuk tes lokal boleh diturunkan lewat .env (MIN_VALID_HOURS=1), JANGAN dipakai di produksi.
const MIN_VALID_HOURS = Number(process.env.MIN_VALID_HOURS || 18);
const COMPUTE_EVERY_MS = 60_000; // hitung ulang iAQI maksimal 1x per menit per node

const client = mqtt.connect(`mqtts://${process.env.MQTT_HOST}:8883`, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  ca: fs.readFileSync(process.env.MQTT_CA_PATH),
  clientId: `bali-airwatch-bridge-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 3000,
});

const inRange = (v, min, max) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

// Kunci jam UTC, contoh: 2026101407
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

const lastCompute = new Map();

async function updateStatus(nodeId) {
  const now = Date.now();
  if (now - (lastCompute.get(nodeId) || 0) < COMPUTE_EVERY_MS) return;
  lastCompute.set(nodeId, now);

  // Ambil 24 dokumen jam terakhir langsung lewat ID (tanpa query, jadi tanpa indeks khusus).
  const refs = Array.from({ length: 24 }, (_, h) =>
    db.collection("hourly").doc(`${nodeId}_${hourKey(now - h * 3600_000)}`)
  );
  const snaps = await db.getAll(...refs);

  let validHours = 0;
  let sumOfHourlyAvg = 0;
  let anyTest = false;
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

  await db.collection("status").doc(nodeId).set({
    nodeId,
    validHours,
    enough, // false = data belum cukup (kurang dari 75%), iAQI tidak dihitung
    avgCoUgm3: avg,
    iaqi,
    category: ispuCategory(iaqi),
    test: anyTest, // true jika ada data uji di jendela 24 jam
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`Status ${nodeId}: jam valid=${validHours}, iAQI=${iaqi}, ${ispuCategory(iaqi) ?? "data belum cukup"}`);
}

client.on("connect", () => {
  console.log("Bridge terhubung ke EMQX");
  client.subscribe("bali-airwatch/+/data", { qos: 1 });
});

client.on("error", (e) => console.error("MQTT error:", e.message));

client.on("message", async (topic, buf) => {
  let d;
  try { d = JSON.parse(buf.toString()); }
  catch { return console.warn("Payload bukan JSON, dibuang"); }

  const nodeId = topic.split("/")[1];
  if (d.nodeId && d.nodeId !== nodeId) return console.warn("nodeId tidak cocok dengan topic, dibuang");
  if (!inRange(d.temp, -40, 80) || !inRange(d.humidity, 0, 100) || !inRange(d.co, 0, 1000)) {
    return console.warn("Nilai di luar rentang, dibuang:", d);
  }

  const isTest = d.test === true;
  const coUgm3 = ppmToUgm3(d.co, d.temp); // d.co dianggap ppm TERKALIBRASI

  try {
    await db.collection(COLLECTION).add({
      nodeId,
      temp: d.temp,
      humidity: d.humidity,
      co: d.co,
      coUgm3,
      test: isTest,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log("Tersimpan:", nodeId, d);

    await addToHourly(nodeId, coUgm3, isTest);
    await updateStatus(nodeId);
  } catch (e) {
    console.error("Gagal tulis Firestore:", e.message);
  }
});
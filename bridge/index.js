import "dotenv/config";
import fs from "node:fs";
import mqtt from "mqtt";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const sa = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT, "utf8"));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const COLLECTION = process.env.FIRESTORE_COLLECTION || "readings";

const client = mqtt.connect(`mqtts://${process.env.MQTT_HOST}:8883`, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  ca: fs.readFileSync(process.env.MQTT_CA_PATH),
  clientId: `bali-airwatch-bridge-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 3000,
});

const inRange = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

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

  try {
    await db.collection(COLLECTION).add({
      nodeId,
      temp: d.temp,
      humidity: d.humidity,
      co: d.co,
      test: d.test === true,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log("Tersimpan:", nodeId, d);
  } catch (e) {
    console.error("Gagal tulis Firestore:", e.message);
  }
});
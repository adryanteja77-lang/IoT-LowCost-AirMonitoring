import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
  where,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// ---------- util waktu ----------
const tsToMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : null);

export function formatClock(ms) {
  if (ms == null) return "";
  return new Date(ms)
    .toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })
    .replace(".", ":");
}

export function formatDateTime(ms) {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------- koleksi "readings": 100 pembacaan terbaru (urut lama -> baru) ----------
export function useSensorReadings() {
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const q = query(
      collection(db, "readings"),
      orderBy("createdAt", "desc"),
      limit(100)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs
          .map((doc) => {
            const raw = doc.data();
            const createdMs = tsToMs(raw.createdAt);
            return {
              id: doc.id,
              ...raw,
              createdMs,
              time: formatClock(createdMs),
            };
          })
          .reverse();

        setReadings(data);
        setError("");
        setLoading(false);
      },
      (err) => {
        console.error("Firestore listener error (readings):", err);
        setError(err.message);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  return { readings, loading, error };
}

// ---------- koleksi "status": hasil iAQI dari bridge, satu dokumen per node ----------
export function useNodeStatus() {
  const [statusMap, setStatusMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "status"),
      (snapshot) => {
        const next = {};
        snapshot.docs.forEach((doc) => {
          const raw = doc.data();
          next[doc.id] = { ...raw, nodeId: raw.nodeId ?? doc.id, updatedMs: tsToMs(raw.updatedAt) };
        });
        setStatusMap(next);
        setError("");
        setLoading(false);
      },
      (err) => {
        console.error("Firestore listener error (status):", err);
        setError(err.message);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  return { statusMap, loading, error };
}

// ---------- koleksi "hourly": agregat per jam (grafik 24 jam sampai 7 hari) ----------
export function useHourly(hoursBack = 26) {
  const [hourly, setHourly] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const since = Timestamp.fromMillis(Date.now() - hoursBack * 3600_000);
    const q = query(
      collection(db, "hourly"),
      where("hourStart", ">=", since),
      orderBy("hourStart", "asc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setHourly(
          snapshot.docs.map((doc) => {
            const raw = doc.data();
            const hourMs = tsToMs(raw.hourStart);
            return {
              id: doc.id,
              nodeId: raw.nodeId,
              hourMs,
              label: formatClock(hourMs),
              count: raw.count ?? 0,
              testCount: raw.testCount ?? 0,
              avgUgm3: raw.count ? raw.sumUgm3 / raw.count : null,
              // Agregat lingkungan (hanya ada pada dokumen jam yang dibuat setelah fitur ini aktif).
              envCount: raw.envCount ?? 0,
              avgPpm: raw.envCount ? raw.sumPpm / raw.envCount : null,
              avgTemp: raw.envCount ? raw.sumTemp / raw.envCount : null,
              avgHum: raw.envCount ? raw.sumHum / raw.envCount : null,
            };
          })
        );
        setError("");
        setLoading(false);
      },
      (err) => {
        console.error("Firestore listener error (hourly):", err);
        setError(err.message);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, [hoursBack]);

  return { hourly, loading, error };
}

// ---------- koleksi "iaqi_log": riwayat iAQI per node per jam ----------
export function useIaqiLog(hoursBack = 170) {
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const since = Timestamp.fromMillis(Date.now() - hoursBack * 3600_000);
    const q = query(
      collection(db, "iaqi_log"),
      where("hourStart", ">=", since),
      orderBy("hourStart", "asc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setLog(
          snapshot.docs.map((doc) => {
            const raw = doc.data();
            const hourMs = tsToMs(raw.hourStart);
            return {
              id: doc.id,
              nodeId: raw.nodeId,
              hourMs,
              iaqi: typeof raw.iaqi === "number" ? raw.iaqi : null,
              avgCoUgm3: raw.avgCoUgm3 ?? null,
              validHours: raw.validHours ?? 0,
              enough: raw.enough === true,
              test: raw.test === true,
            };
          })
        );
        setError("");
        setLoading(false);
      },
      (err) => {
        console.error("Firestore listener error (iaqi_log):", err);
        setError(err.message);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, [hoursBack]);

  return { log, loading, error };
}
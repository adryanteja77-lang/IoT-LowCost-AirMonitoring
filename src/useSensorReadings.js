
import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";

export function useSensorReadings() {
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "sensor_readings"),
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));

        setReadings(data);
        setError("");
        setLoading(false);
      },
      (err) => {
        console.error("Firestore listener error:", err);
        setError(err.message);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  return { readings, loading, error };
}

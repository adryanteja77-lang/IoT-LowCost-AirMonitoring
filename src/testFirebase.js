
import { db } from "./firebase";
import { collection, getDocs } from "firebase/firestore";

export async function testFirebase() {
  try {
    const result = await getDocs(collection(db, "sensor_readings"));
    console.log("Firestore berhasil diakses!");
    console.log("Jumlah dokumen:", result.size);
  } catch (error) {
    console.error("Firestore gagal diakses:", error.code, error.message);
  }
}

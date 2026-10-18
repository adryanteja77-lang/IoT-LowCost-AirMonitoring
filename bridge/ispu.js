// Konversi konsentrasi CO rata-rata 24 jam (µg/m³) menjadi nilai ISPU.
// Sumber: Permen LHK No. P.14/MENLHK/SETJEN/KUM.1/7/2020, Lampiran I (tabel + persamaan 1)
// dan Lampiran II (kategori).
//
// Persamaan: I = (Ia - Ib) / (Xa - Xb) * (Xx - Xb) + Ib
// Kolom CO pada tabel: 4000 / 8000 / 15000 / 30000 / 45000 µg/m³
const CO_SEGMENTS = [
  { xa: 4000, ia: 50 },
  { xa: 8000, ia: 100 },
  { xa: 15000, ia: 200 },
  { xa: 30000, ia: 300 },
  // ASUMSI: baris ">300" memakai Ia = 500. Peraturan tidak menuliskan batas atas ISPU baris ini.
  { xa: 45000, ia: 500 },
];

export function ispuFromCO(xUgm3) {
  if (!Number.isFinite(xUgm3) || xUgm3 < 0) return null;
  let xb = 0; // ASUMSI: batas bawah konsentrasi segmen pertama = 0
  let ib = 0;
  for (const { xa, ia } of CO_SEGMENTS) {
    if (xUgm3 <= xa) {
      return Math.round(((ia - ib) / (xa - xb)) * (xUgm3 - xb) + ib);
    }
    xb = xa;
    ib = ia;
  }
  return 500; // di atas 45000 µg/m³: ditahan di 500
}

// Lampiran II: kategori rentang ISPU
export function ispuCategory(i) {
  if (i == null) return null;
  if (i <= 50) return "Baik";
  if (i <= 100) return "Sedang";
  if (i <= 200) return "Tidak sehat";
  if (i <= 300) return "Sangat tidak sehat";
  return "Berbahaya";
}

// ppm -> µg/m³ untuk CO (BM 28,01 g/mol), tekanan 1 atm, suhu dari DHT22.
// Peraturan tidak menyebut kondisi acuan konversi: ini asumsi dan harus ditulis di dokumentasi.
export function ppmToUgm3(ppm, tempC = 25) {
  const molarVolumeL = (22.414 * (273.15 + tempC)) / 273.15;
  return (ppm * 28.01 * 1000) / molarVolumeL;
}
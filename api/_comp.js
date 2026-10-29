// Koreksi suhu & RH untuk respons MQ-7 (EKSPERIMENTAL).
// Model: Rs_koreksi = Rs / exp( a*(T - T_ref) + b*(RH - RH_ref) )
// Arah sesuai Fig. 4 datasheet Hanwei: Rs turun saat suhu/RH naik, jadi a dan b bernilai NEGATIF.
// Koefisien dicocokkan dari data udara bersih tiap node (lihat fit_koreksi.py), BUKAN dari tebakan.
//
// Dipakai lewat env var COMP_CONFIG (JSON), contoh:
// {"node-01":{"ro":2440,"a":-0.004,"b":-0.0012,"tRef":30,"rhRef":70,"validated":true},
//  "node-02":{"ro":2792,"a":-0.004,"b":-0.0012,"tRef":30,"rhRef":70,"validated":false}}
// Tanpa a/b, atau tanpa Ro, node tidak dikoreksi (coComp = null).
// validated:true  -> iAQI memakai nilai terkoreksi. validated:false -> hanya disimpan sebagai pembanding.

const PPM_A = 99.042;
const PPM_B = -1.518;

let CFG = {};
try { CFG = JSON.parse(process.env.COMP_CONFIG || "{}"); } catch { CFG = {}; }

export const compConfig = (nodeId) => CFG[nodeId] || null;

// Rs dari payload; jika firmware lama tidak mengirim rs, balik-hitung dari ppm dan Ro.
export function resolveRs(d, ro) {
  if (Number.isFinite(d.rs) && d.rs > 0) return d.rs;
  if (ro && d.co > 0 && d.co < 1000) return ro * Math.pow(d.co / PPM_A, 1 / PPM_B);
  return null;
}

// Mengembalikan { rs, coComp, useComp } ; coComp null jika koreksi tidak tersedia.
export function compensate(nodeId, d) {
  const c = compConfig(nodeId);
  const rs = resolveRs(d, c?.ro);
  if (!c || !c.ro || !Number.isFinite(c.a) || !Number.isFinite(c.b) || !rs) {
    return { rs, coComp: null, useComp: false };
  }
  const f = Math.exp(c.a * (d.temp - c.tRef) + c.b * (d.humidity - c.rhRef));
  const rsComp = rs / f;
  let ppm = PPM_A * Math.pow(rsComp / c.ro, PPM_B);
  if (!Number.isFinite(ppm) || ppm < 0) ppm = 0;
  if (ppm > 1000) ppm = 1000;
  return { rs, coComp: Math.round(ppm * 100) / 100, useComp: c.validated === true };
}
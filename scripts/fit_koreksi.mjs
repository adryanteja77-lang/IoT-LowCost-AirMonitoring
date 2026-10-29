// Cocokkan koefisien koreksi suhu/RH MQ-7 dari data udara bersih di Firestore.
// Jalankan dari root repo web (butuh firebase-admin, sudah ada di dependensi):
//   $env:FIREBASE_SERVICE_ACCOUNT_JSON = Get-Content serviceAccount.json -Raw   (PowerShell)
//   node scripts/fit_koreksi.mjs node-01 node-02
// Model: ln(Rs) = c + a*(T-Tref) + b*(RH-RHref).  Koreksi: Rs_k = Rs / exp(a*dT + b*dRH).
// JANGAN jalankan saat ada uji asap/dupa di jendela data (filter hanya membuang lonjakan kasar).

import { pathToFileURL } from "node:url";

const PPM_A = 99.042, PPM_B = -1.518;
const median = (v) => { const s = [...v].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

function solve3(A, y) { // regresi 3 parameter lewat persamaan normal (eliminasi Gauss)
  const M = Array.from({ length: 3 }, (_, i) => [...Array(3)].map((_, j) => A.reduce((s, r) => s + r[i] * r[j], 0)).concat(A.reduce((s, r, k) => s + r[i] * y[k], 0)));
  for (let i = 0; i < 3; i++) {
    let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c]; }
  }
  return [0, 1, 2].map((i) => M[i][3] / M[i][i]);
}
const corr = (x, y) => { const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; x.forEach((_, i) => { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }); return sxy / Math.sqrt(sxx * syy); };

// rows: [{t (ms), temp, hum, rs}] urut waktu. Mengembalikan hasil fit + verdict.
export function fitNode(rows, ro) {
  const med = median(rows.map((r) => r.rs));
  const clean = rows.filter((r) => r.rs > 0.8 * med && r.rs < 1.5 * med); // buang asap (Rs turun) & glitch
  const n = clean.length;
  if (n < 50) return { ok: false, reason: `data bersih terlalu sedikit (${n})`, n };
  const cut = Math.floor(n * 0.7);
  const tr = clean.slice(0, cut), te = clean.slice(cut);
  const Tref = mean(tr.map((r) => r.temp)), Href = mean(tr.map((r) => r.hum));
  const X = (r) => [1, r.temp - Tref, r.hum - Href], Y = (r) => Math.log(r.rs);
  const beta = solve3(tr.map(X), tr.map(Y));
  if (!beta) return { ok: false, reason: "suhu dan RH hampir kolinear / tidak bervariasi", n };
  const [, a, b] = beta;
  const pred = (r) => beta[0] + a * (r.temp - Tref) + b * (r.hum - Href);
  const r2 = (set, mdl) => { const m = mean(set.map(Y)); const ssT = set.reduce((s, r) => s + (Y(r) - m) ** 2, 0); const ssR = set.reduce((s, r) => s + (Y(r) - mdl(r)) ** 2, 0); return 1 - ssR / ssT; };
  const r2Train = r2(tr, pred);
  const r2Test = r2(te, (r) => pred(r)); // di data hold-out (30% terakhir)
  const rTH = corr(clean.map((r) => r.temp), clean.map((r) => r.hum));
  const spanT = Math.max(...clean.map((r) => r.temp)) - Math.min(...clean.map((r) => r.temp));
  const spanH = Math.max(...clean.map((r) => r.hum)) - Math.min(...clean.map((r) => r.hum));
  const issues = [];
  if (!(a < 0)) issues.push("koefisien suhu tidak negatif (bertentangan dengan Fig. 4)");
  if (!(b < 0)) issues.push("koefisien RH tidak negatif (bertentangan dengan Fig. 4)");
  if (r2Test < 0.3) issues.push(`R² hold-out rendah (${r2Test.toFixed(2)})`);
  if (spanT < 4) issues.push(`rentang suhu sempit (${spanT.toFixed(1)} °C)`);
  if (spanH < 10) issues.push(`rentang RH sempit (${spanH.toFixed(0)} %)`);
  if (Math.abs(rTH) > 0.9) issues.push(`suhu dan RH sangat berkorelasi (r=${rTH.toFixed(2)}), koefisien tidak bisa dipisah`);
  if (n < 200) issues.push(`data bersih masih sedikit (${n})`);
  const cfg = { ro, a: +a.toFixed(5), b: +b.toFixed(5), tRef: +Tref.toFixed(1), rhRef: +Href.toFixed(0), validated: issues.length === 0 };
  return { ok: true, n, buang: rows.length - n, r2Train, r2Test, rTH, spanT, spanH, issues, cfg };
}

async function main() {
  const { initializeApp, cert, getApps } = await import("firebase-admin/app");
  const { getFirestore, Timestamp } = await import("firebase-admin/firestore");
  const nodes = process.argv.slice(2);
  const RO = { "node-01": 2440, "node-02": 2792 };
  if (!nodes.length) { console.log("pakai: node scripts/fit_koreksi.mjs node-01 node-02"); return; }
  if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  const db = getFirestore();
  const since = Timestamp.fromMillis(Date.now() - 14 * 86400_000);
  const out = {};
  for (const id of nodes) {
    const snap = await db.collection("readings").where("nodeId", "==", id).where("createdAt", ">=", since).orderBy("createdAt", "asc").get();
    const rows = [];
    snap.forEach((d) => {
      const x = d.data();
      if (x.warmup === true || x.test === true) return;
      let rs = x.rs;
      if (!(rs > 0) && x.co > 0 && x.co < 1000 && RO[id]) rs = RO[id] * Math.pow(x.co / PPM_A, 1 / PPM_B); // fallback data lama (kurang presisi)
      if (rs > 0 && Number.isFinite(x.temp) && Number.isFinite(x.humidity)) rows.push({ t: x.createdAt.toMillis(), temp: x.temp, hum: x.humidity, rs });
    });
    const r = fitNode(rows, RO[id]);
    console.log(`\n=== ${id}: ${rows.length} pembacaan ===`);
    if (!r.ok) { console.log("GAGAL:", r.reason); continue; }
    console.log(`data bersih ${r.n} (dibuang ${r.buang}) | rentang suhu ${r.spanT.toFixed(1)} °C, RH ${r.spanH.toFixed(0)} %`);
    console.log(`a(suhu)=${r.cfg.a}  b(RH)=${r.cfg.b}  | R² latih ${r.r2Train.toFixed(2)}, R² hold-out ${r.r2Test.toFixed(2)}`);
    console.log(r.issues.length ? "BELUM LOLOS:\n - " + r.issues.join("\n - ") : "LOLOS validasi -> validated:true");
    out[id] = r.cfg;
  }
  console.log("\nIsi env COMP_CONFIG di Vercel dengan:\n" + JSON.stringify(out));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";

import {
  Activity,
  AirVent,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Bell,
  ChevronDown,
  BookOpen,
  Clock3,
  Download,
  Gauge,
  LayoutDashboard,
  MapPin,
  Menu,
  RadioTower,
  Search,
  ShieldCheck,
  Thermometer,
  Wifi,
  Wind,
  X,
  Droplets,
} from "lucide-react";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  useSensorReadings,
  useNodeStatus,
  useHourly,
  useIaqiLog,
  formatClock,
  formatDateTime,
} from "./useSensorReadings";
import NodeMap from "./NodeMap";
import { NODE_META, PLANNED_SITES } from "./NodeMeta";
import { EVENTS } from "./Events";

const navItems = [
  { id: "overview", label: "Public View", icon: LayoutDashboard },
  { id: "analytics", label: "Stakeholder Analytics", icon: Activity },
  { id: "nodes", label: "Monitoring Nodes", icon: RadioTower },
  { id: "method", label: "Metodologi", icon: BookOpen },
];

// Pasal 7 Permen LHK P.14/2020: minimal 75% data valid dalam 24 jam = 18 jam.
const REQUIRED_HOURS = 18;
// Node dianggap offline kalau pesan terakhir lebih dari 10 menit lalu
// (node mengirim sekitar tiap 2,5 menit).
const OFFLINE_AFTER_MS = 10 * 60 * 1000;
// Batas atas kategori "Baik" untuk CO 24 jam (µg/m³).
const CO_BAIK_LIMIT = 4000;

// Kategori ISPU (Lampiran II) dan warna standarnya.
const SCALE = [
  { key: "baik", label: "Baik", lo: 0, hi: 50 },
  { key: "sedang", label: "Sedang", lo: 50, hi: 100 },
  { key: "tidak-sehat", label: "Tidak sehat", lo: 100, hi: 200 },
  { key: "sangat", label: "Sangat tidak sehat", lo: 200, hi: 300 },
  { key: "berbahaya", label: "Berbahaya", lo: 300, hi: 500 },
];

const CATEGORY_KEY = {
  Baik: "baik",
  Sedang: "sedang",
  "Tidak sehat": "tidak-sehat",
  "Sangat tidak sehat": "sangat",
  Berbahaya: "berbahaya",
};

// --------------------------------------------------
// HELPER FUNCTIONS
// --------------------------------------------------

function formatNumber(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "—";
}

function average(values) {
  const valid = values.filter(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
  return valid.length
    ? valid.reduce((total, value) => total + value, 0) / valid.length
    : null;
}

const toNumber = (v) => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

// Posisi penanda pada skala 5 segmen (0-100%).
function scalePosition(iaqi) {
  if (iaqi == null) return null;
  const idx = SCALE.findIndex((seg) => iaqi <= seg.hi);
  if (idx === -1) return 100;
  const seg = SCALE[idx];
  const frac = Math.min(1, Math.max(0, (iaqi - seg.lo) / (seg.hi - seg.lo)));
  return ((idx + frac) / SCALE.length) * 100;
}

const RANGES = [
  { id: "24", label: "24 jam", hours: 24 },
  { id: "72", label: "3 hari", hours: 72 },
  { id: "168", label: "7 hari", hours: 168 },
];
const NODE_COLORS = ["#168574", "#8564c7", "#c78338", "#4d8fd7", "#c0392b"];
const SAMPLES_PER_HOUR = 24; // 3600 s / 150 s per siklus heater

// Label sumbu-X: jam saja untuk 24 jam, tanggal + jam untuk rentang lebih panjang.
function axisLabel(ms, long) {
  if (ms == null) return "";
  if (!long) return formatClock(ms);
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1} ${formatClock(ms)}`;
}

// Gabungkan deret per node menjadi satu tabel: satu baris per jam, satu kolom per node.
function pivotByHour(rows, valueKey, long) {
  const byHour = new Map();
  rows.forEach((r) => {
    if (r.hourMs == null || r[valueKey] == null) return;
    const row = byHour.get(r.hourMs) ?? { hourMs: r.hourMs, time: axisLabel(r.hourMs, long) };
    row[r.nodeId] = r[valueKey];
    byHour.set(r.hourMs, row);
  });
  return [...byHour.values()].sort((a, b) => a.hourMs - b.hourMs);
}

// Korelasi Pearson; null kalau data kurang atau tanpa variasi.
function pearson(pairs) {
  const n = pairs.length;
  if (n < 6) return null;
  const mx = average(pairs.map((p) => p.x));
  const my = average(pairs.map((p) => p.y));
  let sxy = 0, sxx = 0, syy = 0;
  pairs.forEach((p) => {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  });
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// --------------------------------------------------
// EXCEL EXPORT (data nyata dari Firestore)
// --------------------------------------------------

// Saran umum per kategori (parafrase, bukan nasihat medis).
const ADVICE = {
  baik: "Udara baik untuk aktivitas luar ruangan seperti berjalan kaki, bersepeda, dan wisata pantai.",
  sedang: "Umumnya aman. Anak-anak, lansia, dan penderita gangguan pernapasan sebaiknya memantau kondisi.",
  "tidak-sehat": "Kurangi aktivitas berat di luar ruangan, terutama kelompok sensitif, dan hindari area padat kendaraan.",
  sangat: "Batasi aktivitas luar ruangan. Kelompok sensitif sebaiknya tetap di dalam ruangan.",
  berbahaya: "Hindari aktivitas luar ruangan dan ikuti arahan otoritas setempat.",
};

// Arah tren: rata-rata 3 jam terakhir vs 3 jam sebelumnya (butuh 6 jam data dalam rentang 8 jam).
function computeTrend(hourly) {
  const v = hourly.filter((h) => h.avgUgm3 != null && h.hourMs != null);
  if (v.length < 6) return null;
  const last6 = v.slice(-6);
  if (last6[5].hourMs - last6[0].hourMs > 8 * 3600_000) return null;
  const a = average(last6.slice(3).map((h) => h.avgUgm3));
  const b = average(last6.slice(0, 3).map((h) => h.avgUgm3));
  if (a == null || !b) return null;
  const pct = ((a - b) / b) * 100;
  return { direction: pct > 10 ? "naik" : pct < -10 ? "turun" : "stabil", pct, recent: a, before: b };
}

function downloadExcel(filename, { status, readings, hourly }) {
  const statusRows = status
    ? [
        {
          Node: status.nodeId,
          "iAQI (CO, 24 jam)": status.iaqi ?? "Data belum cukup",
          Kategori: status.category ?? "—",
          "Rata-rata CO 24 jam (µg/m³)":
            status.avgCoUgm3 != null ? Math.round(status.avgCoUgm3) : "",
          "Jam data valid": status.validHours ?? "",
          "Data cukup (≥75%)": status.enough ? "Ya" : "Tidak",
          "Berisi data uji": status.test ? "Ya" : "Tidak",
          Diperbarui: formatDateTime(status.updatedMs),
        },
      ]
    : [];

  const readingRows = readings.map((r) => ({
    Waktu: formatDateTime(r.createdMs),
    Node: r.nodeId,
    "Suhu (°C)": r.temp ?? "",
    "Kelembapan (%)": r.humidity ?? "",
    "CO indikatif (ppm)": r.co ?? "",
    "CO (µg/m³)": r.coUgm3 != null ? Math.round(r.coUgm3) : "",
    "Jenis data": r.test ? "Uji" : r.warmup ? "Pemanasan" : "Terukur",
  }));

  const hourlyRows = hourly.map((h) => ({
    Jam: formatDateTime(h.hourMs),
    Node: h.nodeId,
    "Rata-rata CO (µg/m³)": h.avgUgm3 != null ? Math.round(h.avgUgm3) : "",
    "Rata-rata CO (ppm)": h.avgPpm != null ? Number(h.avgPpm.toFixed(3)) : "",
    "Rata-rata suhu (°C)": h.avgTemp != null ? Number(h.avgTemp.toFixed(2)) : "",
    "Rata-rata RH (%)": h.avgHum != null ? Number(h.avgHum.toFixed(1)) : "",
    "Jumlah sampel": h.count,
    "Sampel uji": h.testCount,
  }));

  const workbook = XLSX.utils.book_new();
  const sheets = [
    ["Status iAQI", statusRows],
    ["Readings", readingRows],
    ["Hourly", hourlyRows],
  ];

  sheets.forEach(([name, rows]) => {
    const ws = XLSX.utils.json_to_sheet(rows);
    if (rows.length > 0) {
      ws["!cols"] = Object.keys(rows[0]).map((key) => ({
        wch: Math.max(14, key.length + 2),
      }));
    }
    XLSX.utils.book_append_sheet(workbook, ws, name);
  });

  XLSX.writeFile(workbook, filename);
}

// --------------------------------------------------
// MAIN APP
// --------------------------------------------------

function App() {
  const {
    readings: rawReadings,
    loading: readingsLoading,
    error: readingsError,
  } = useSensorReadings();
  const {
    statusMap,
    loading: statusLoading,
    error: statusError,
  } = useNodeStatus();
  const {
    hourly: rawHourly,
    loading: hourlyLoading,
    error: hourlyError,
  } = useHourly(24 * 7 + 2);
  const {
    log: rawIaqiLog,
    error: iaqiLogError,
  } = useIaqiLog(24 * 7 + 2);

  const [page, setPage] = useState("overview");
  const [search, setSearch] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [now, setNow] = useState(Date.now());
  const [rangeId, setRangeId] = useState("24");

  // Perbarui "sekarang" tiap 30 detik supaya status online/offline ikut berubah.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const loading = readingsLoading || statusLoading || hourlyLoading;
  const errors = [
    readingsError && `readings: ${readingsError}`,
    statusError && `status: ${statusError}`,
    hourlyError && `hourly: ${hourlyError}`,
    iaqiLogError && `iaqi_log: ${iaqiLogError}`,
  ].filter(Boolean);

  // Normalisasi angka pembacaan.
  const readings = useMemo(
    () =>
      rawReadings.map((item) => ({
        ...item,
        nodeId: item.nodeId ?? "UNKNOWN",
        temp: toNumber(item.temp ?? item.temperature),
        humidity: toNumber(item.humidity),
        co: toNumber(item.co),
        coUgm3: toNumber(item.coUgm3),
        coComp: toNumber(item.coComp),
        compUsed: item.compUsed === true,
        test: item.test === true,
        warmup: item.warmup === true,
      })),
    [rawReadings]
  );

  // Daftar node dari status + pembacaan terbaru.
  const nodes = useMemo(() => {
    const latest = new Map();
    readings.forEach((r) => {
      if (r.nodeId === "UNKNOWN") return;
      const existing = latest.get(r.nodeId);
      if (!existing || (r.createdMs ?? 0) >= (existing.createdMs ?? 0)) {
        latest.set(r.nodeId, r);
      }
    });

    const ids = new Set([...latest.keys(), ...Object.keys(statusMap)]);

    return [...ids].sort().map((id) => {
      const r = latest.get(id);
      const s = statusMap[id];
      const lastMs = r?.createdMs ?? s?.updatedMs ?? null;
      const online = lastMs != null && now - lastMs <= OFFLINE_AFTER_MS;
      return {
        id,
        name: r?.location ?? id,
        area: r?.area ?? "Belum ditentukan",
        status: online ? "Online" : "Offline",
        lastSeen: formatDateTime(lastMs),
        lastMs,
        temp: r?.temp ?? null,
        humidity: r?.humidity ?? null,
        co: r?.co ?? null,
        test: r?.test === true,
        warmup: r?.warmup === true,
        iaqi: s?.enough === true ? s.iaqi ?? null : null,
        category: s?.enough === true ? s.category ?? null : null,
        validHours: s?.validHours ?? 0,
      };
    });
  }, [readings, statusMap, now]);

  const activeId = nodes.some((n) => n.id === selectedNodeId)
    ? selectedNodeId
    : nodes[0]?.id ?? "";
  const activeNode = nodes.find((n) => n.id === activeId) ?? null;
  const status = activeId ? statusMap[activeId] ?? null : null;

  const nodeReadings = useMemo(
    () => readings.filter((r) => r.nodeId === activeId),
    [readings, activeId]
  );

  const nodeHourly = useMemo(
    () =>
      rawHourly.filter(
        (h) => h.nodeId === activeId && h.hourMs != null && h.hourMs >= now - 24 * 3600_000
      ),
    [rawHourly, activeId, now]
  );

  const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[0];
  const rangeHourly = useMemo(
    () => rawHourly.filter((h) => h.hourMs != null && h.hourMs >= now - range.hours * 3600_000),
    [rawHourly, now, range]
  );
  const rangeIaqi = useMemo(
    () => rawIaqiLog.filter((h) => h.hourMs != null && h.hourMs >= now - range.hours * 3600_000),
    [rawIaqiLog, now, range]
  );

  const latestReading = nodeReadings.length
    ? nodeReadings[nodeReadings.length - 1]
    : null;

  const trend = useMemo(() => computeTrend(nodeHourly), [nodeHourly]);
  const activeMeta = NODE_META[activeId] ?? null;

  const mapPoints = useMemo(() => {
    const real = nodes
      .map((n) => {
        const meta = NODE_META[n.id];
        if (!meta) return null;
        const st = statusMap[n.id];
        const ok = st?.enough === true && st.iaqi != null;
        return {
          id: n.id, name: meta.name, area: meta.area, lat: meta.lat, lng: meta.lng,
          planned: false, iaqi: ok ? st.iaqi : null, category: ok ? st.category : null,
          online: n.status === "Online", test: st?.test === true,
        };
      })
      .filter(Boolean);
    return [...real, ...PLANNED_SITES.map((s) => ({ ...s, planned: true }))];
  }, [nodes, statusMap]);

  const unmapped = nodes.filter((n) => !NODE_META[n.id]).map((n) => n.id);

  const filteredNodes = useMemo(() => {
    const query = search.trim().toLowerCase();
    return nodes.filter((node) =>
      `${node.id} ${node.name} ${node.area} ${node.status}`
        .toLowerCase()
        .includes(query)
    );
  }, [nodes, search]);

  const onlineCount = nodes.filter((n) => n.status === "Online").length;

  const exportReport = () => {
    try {
      const date = new Date().toISOString().slice(0, 10);
      downloadExcel(`bali-airwatch-${activeId || "data"}-${date}.xlsx`, {
        status,
        readings: nodeReadings,
        hourly: rawHourly.filter((h) => h.nodeId === activeId),
      });
      setNotice("Laporan Excel dibuat dari data Firestore node yang dipilih.");
    } catch (error) {
      console.error("Export Excel gagal:", error);
      setNotice("Export Excel gagal. Pastikan package xlsx sudah terpasang.");
    }
  };

  const openMethod = () => {
    setPage("method");
    setMobileNav(false);
    setNotice("");
  };

  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="mobile-scrim"
          aria-label="Tutup menu"
          onClick={() => setMobileNav(false)}
        />
      )}

      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Wind size={23} />
          </div>

          <div>
            <div className="brand-name">Bali AirWatch</div>
            <div className="brand-subtitle">AIR QUALITY NETWORK</div>
          </div>

          <button
            className="icon-button close-nav"
            aria-label="Tutup navigasi"
            onClick={() => setMobileNav(false)}
          >
            <X size={18} />
          </button>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="nav-list">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => {
                setPage(id);
                setMobileNav(false);
                setNotice("");
              }}
            >
              <Icon size={18} />
              <span>{label}</span>

              {id === "nodes" && <span className="nav-count">{nodes.length}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="location-card">
            <div className="location-icon">
              <MapPin size={17} />
            </div>

            <div>
              <strong>Bali, Indonesia</strong>
              <span>Distributed monitoring</span>
            </div>
          </div>

          <div className="profile">
            <div className="avatar">BA</div>

            <div className="profile-copy">
              <strong>Research workspace</strong>
              <span>Prototype environment</span>
            </div>

            <ChevronDown size={16} className="muted-icon" />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Buka menu"
            onClick={() => setMobileNav(true)}
          >
            <Menu size={20} />
          </button>

          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="crumb-slash">/</span>
            <strong>{navItems.find((item) => item.id === page)?.label}</strong>
          </div>

          <div className="topbar-actions">
            <div className="environment-pill">
              <span className="environment-dot" />
              <span>PROTOTYPE · LIVE DATA</span>
            </div>

            <button
              className="icon-button notification-button"
              aria-label="Metodologi iAQI"
              title="Metodologi iAQI"
              onClick={openMethod}
            >
              <Bell size={18} />
              <i />
            </button>

            <div className="top-avatar">BA</div>
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" />
                ENVIRONMENTAL INTELLIGENCE
              </div>

              <h1>
                {page === "overview"
                  ? "Kualitas Udara Saat Ini"
                  : page === "analytics"
                    ? "Stakeholder Analytics"
                    : page === "method"
                      ? "Metodologi iAQI"
                      : "Monitoring Nodes"}
              </h1>

              <p>
                {page === "overview"
                  ? "Informasi kualitas udara untuk masyarakat dan wisatawan, mendukung Green & Healthy Tourism di kawasan wisata Bali."
                  : page === "analytics"
                    ? "Tren CO, suhu, dan kelembapan per node untuk instansi terkait."
                    : page === "method"
                      ? "Cara data sensor diolah menjadi indeks, beserta batasan dan asumsinya."
                      : "Pantau status perangkat sensor terdistribusi."}
              </p>
            </div>

            {page !== "method" && (
            <div className="heading-actions">
              {nodes.length > 1 && (
                <select
                  className="node-select"
                  value={activeId}
                  onChange={(event) => setSelectedNodeId(event.target.value)}
                  aria-label="Pilih node"
                >
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.id}
                    </option>
                  ))}
                </select>
              )}

              <button
                className="button button-primary"
                onClick={exportReport}
                disabled={!activeId}
              >
                <Download size={15} />
                Export report
              </button>
            </div>
            )}
          </div>

          {page !== "method" && (
          <div className="simulation-banner">
            <div className="sim-icon">
              <ShieldCheck size={18} />
            </div>

            <div>
              <strong>Prototipe dengan sensor berbiaya rendah</strong>
              <span>
                iAQI dihitung dari CO saja (sensor MQ-7) mengikuti rumus ISPU
                Permen LHK P.14/2020. Nilainya indikatif dan melengkapi, bukan
                menggantikan, stasiun pemantau resmi.
              </span>
            </div>

            <span className="sim-tag">INDIKATIF</span>
          </div>
          )}

          {loading && (
            <div className="info-callout">
              <Clock3 size={18} />
              <div>
                <strong>Memuat</strong>
                <span>Mengambil data sensor dari Firestore...</span>
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <div className="info-callout error-callout" role="alert">
              <ShieldCheck size={18} />
              <div>
                <strong>Gagal memuat sebagian data Firestore</strong>
                <span>
                  {errors.join(" | ")}. Cek aturan Firestore (izin baca untuk
                  readings, status, hourly, iaqi_log) dan variabel VITE_FIREBASE_*.
                </span>
              </div>
            </div>
          )}

          {notice && (
            <div className="info-callout" role="status">
              <ShieldCheck size={18} />

              <div>
                <strong>Informasi</strong>
                <span>{notice}</span>
              </div>

              <button
                className="icon-button"
                aria-label="Tutup informasi"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}

          {page === "overview" && (
            <PublicView
              loading={loading}
              node={activeNode}
              status={status}
              latestReading={latestReading}
              readings={nodeReadings}
              setPage={setPage}
              now={now}
              trend={trend}
              mapPoints={mapPoints}
              unmapped={unmapped}
              activeMeta={activeMeta}
              nodes={nodes}
              onPickNode={setSelectedNodeId}
              activeId={activeId}
            />
          )}

          {page === "analytics" && (
            <Analytics
              node={activeNode}
              status={status}
              readings={nodeReadings}
              hourly={nodeHourly}
              rangeHourly={rangeHourly}
              rangeIaqi={rangeIaqi}
              nodes={nodes}
              activeId={activeId}
              range={range}
              setRangeId={setRangeId}
              trend={trend}
            />
          )}

          {page === "method" && <Methodology />}

          {page === "nodes" && (
            <Nodes
              search={search}
              setSearch={setSearch}
              filteredNodes={filteredNodes}
              totalNodes={nodes.length}
              onlineCount={onlineCount}
            />
          )}

          <footer className="footer">
            <span>© 2026 Bali AirWatch</span>

            <span>
              <span className="footer-dot" />
              Prototype dashboard
              <span className="footer-divider">·</span>
              Built for distributed air quality monitoring
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}

// --------------------------------------------------
// PUBLIC VIEW
// --------------------------------------------------

function AqiHero({ node, status, now, meta }) {
  const hasStatus = status != null;
  const enough = hasStatus && status.enough === true && status.iaqi != null;
  const catKey = enough ? CATEGORY_KEY[status.category] ?? "baik" : "none";
  const validHours = status?.validHours ?? 0;
  const progress = Math.min(100, (validHours / REQUIRED_HOURS) * 100);
  const marker = enough ? scalePosition(status.iaqi) : null;
  const loweredRule = enough && validHours < REQUIRED_HOURS;
  const stale = status?.updatedMs != null && now - status.updatedMs > 60 * 60 * 1000;

  return (
    <section className={`panel aqi-hero cat-${catKey}`}>
      <div className="aqi-head">
        <div>
          <h2>Indeks kualitas udara (iAQI)</h2>
          <p>
            {node ? `Node ${node.id}${meta?.area ? ` · ${meta.area}` : ""}` : "Belum ada node"} · CO rata-rata 24 jam
          </p>
        </div>

        <div className="aqi-tags">
          {status?.test && <span className="tag tag-test">DATA UJI</span>}
          <span className="tag">INDIKATIF</span>
        </div>
      </div>

      <div className="aqi-body">
        {enough ? (
          <>
            <div className="aqi-number">{status.iaqi}</div>
            <div className="aqi-copy">
              <span className={`aqi-category cat-chip-${catKey}`}>
                {status.category}
              </span>
              <span className="aqi-sub">
                Rata-rata CO 24 jam: {Math.round(status.avgCoUgm3)} µg/m³ ·{" "}
                {validHours} jam data valid
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="aqi-number aqi-number-empty">—</div>
            <div className="aqi-copy">
              <span className="aqi-category cat-chip-none">
                {hasStatus ? "Data belum cukup" : "Belum ada data iAQI"}
              </span>
              <span className="aqi-sub">
                {hasStatus
                  ? `iAQI dihitung setelah minimal 75% data valid dalam 24 jam (${REQUIRED_HOURS} dari 24 jam). Saat ini ${validHours} jam.`
                  : "Menunggu node mengirim data dan bridge menghitung iAQI."}
              </span>
              {hasStatus && (
                <div className="aqi-progress" aria-label="Kelengkapan data 24 jam">
                  <span style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <div className="aqi-scale" aria-hidden="true">
        {SCALE.map((seg) => (
          <span key={seg.key} className={`seg seg-${seg.key}`} />
        ))}
        {marker != null && <i style={{ left: `${marker}%` }} />}
      </div>
      <div className="aqi-scale-labels">
        {SCALE.map((seg) => (
          <span key={seg.key}>{seg.label}</span>
        ))}
      </div>

      {enough && ADVICE[catKey] && (
        <div className="aqi-advice">
          <strong>Saran untuk wisatawan:</strong> {ADVICE[catKey]}
          <span>Informasi umum berdasarkan CO saja, bukan nasihat medis.</span>
        </div>
      )}

      {loweredRule && (
        <div className="aqi-warning">
          Mode uji: syarat minimal jam data diturunkan di bridge. Jangan dipakai
          sebagai hasil resmi.
        </div>
      )}
      {stale && (
        <div className="aqi-warning">
          Node belum mengirim data baru sejak {formatDateTime(status.updatedMs)}.
          Nilai ini mungkin sudah usang.
        </div>
      )}
      {status?.updatedMs && (
        <div className="aqi-updated">
          <Clock3 size={13} /> Diperbarui {formatDateTime(status.updatedMs)}
        </div>
      )}
    </section>
  );
}

function PublicView({ loading, node, status, latestReading, readings, setPage, now, trend, mapPoints, unmapped, activeMeta, nodes, onPickNode, activeId }) {
  const lastMs = latestReading?.createdMs ?? null;
  const fresh = lastMs != null && now - lastMs <= OFFLINE_AFTER_MS;

  return (
    <>
      <div className="section-toolbar">
        <div className="section-label">
          KONDISI SAAT INI <span className="tiny-dot" />
        </div>

        <div className="toolbar-right">
          <span className="updated-text">
            <Clock3 size={14} />
            {lastMs ? `Data terakhir ${formatClock(lastMs)}` : "Belum ada data"}
          </span>
        </div>
      </div>

      <AqiHero node={node} status={status} now={now} meta={activeMeta} />

      <div className="metric-grid public-metrics">
        <MetricCard
          title="CO terbaru (indikatif)"
          value={latestReading?.co != null ? formatNumber(latestReading.co, 1) : "—"}
          suffix="ppm"
          icon={AirVent}
          tone="purple"
          change={
            latestReading?.test
              ? "Data uji, belum terkalibrasi"
              : latestReading?.warmup
                ? "Sensor masih pemanasan, belum dihitung"
                : latestReading?.coComp != null
                  ? `Terkoreksi suhu/RH (eksperimental): ${formatNumber(latestReading.coComp, 2)} ppm`
                  : "Perkiraan sensor MQ-7"
          }
        />

        <MetricCard
          title="Suhu"
          value={formatNumber(latestReading?.temp)}
          suffix="°C"
          icon={Thermometer}
          tone="orange"
          change="Dari sensor DHT22"
        />

        <MetricCard
          title="Kelembapan"
          value={formatNumber(latestReading?.humidity, 0)}
          suffix="%"
          icon={Droplets}
          tone="blue"
          change="Dari sensor DHT22"
        />

        <MetricCard
          title="Status node"
          value={node ? (fresh ? "Online" : "Offline") : "—"}
          suffix=""
          icon={Wifi}
          tone="green"
          change={lastMs ? `Terakhir terlihat ${formatDateTime(lastMs)}` : "Belum ada pesan"}
        />
      </div>

      {nodes.length > 0 && (
        <section className="panel node-list-panel">
          <div className="panel-header">
            <div>
              <h2>Semua lokasi</h2>
              <p>Pilih lokasi untuk melihat detailnya</p>
            </div>
            <RadioTower size={19} color="#168574" />
          </div>
          <div className="node-list">
            {nodes.map((n) => {
              const key = n.iaqi != null ? CATEGORY_KEY[n.category] ?? "baik" : "none";
              return (
                <button
                  key={n.id}
                  className={`node-list-item ${n.id === activeId ? "active" : ""}`}
                  onClick={() => onPickNode(n.id)}
                >
                  <span className={`node-list-badge cat-chip-${key}`}>{n.iaqi ?? "N/A"}</span>
                  <span className="node-list-copy">
                    <strong>{NODE_META[n.id]?.name ?? n.id}</strong>
                    <span>
                      {n.iaqi != null
                        ? n.category
                        : `Data ${n.validHours}/${REQUIRED_HOURS} jam`}
                      {" · "}
                      {n.status === "Online" ? (n.warmup ? "Pemanasan" : "Online") : "Offline"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="main-grid public-grid">
        <section className="panel map-panel">
          <div className="panel-header">
            <div>
              <h2>Peta jaringan sensor</h2>
              <p>
                Warna mengikuti kategori iAQI. Titik putih bertanda + adalah rencana
                lokasi, belum terpasang.
              </p>
            </div>
            <MapPin size={19} color="#168574" />
          </div>
          <NodeMap points={mapPoints} />
          {unmapped.length > 0 && (
            <div className="map-note">
              Node {unmapped.join(", ")} belum punya koordinat. Isi di src/NodeMeta.jsx.
            </div>
          )}
        </section>

        <TrendPanel trend={trend} />
      </div>

      <div className="main-grid public-grid">
        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Tren CO terbaru</h2>
              <p>Pembacaan terakhir dari node (ppm, indikatif)</p>
            </div>

            <button className="text-button" onClick={() => setPage("analytics")}>
              Lihat analitik <ArrowUpRight size={15} />
            </button>
          </div>

          <ChartBody
            data={readings}
            dataKey="co"
            stroke="#8564c7"
            suffix=" ppm"
            tooltipLabel="CO"
            loading={loading}
            height="chart-wrap"
          />
        </section>

        <section className="panel conditions-panel">
          <div className="panel-header">
            <div>
              <h2>Cara membaca</h2>
              <p>Singkat dan jujur soal batasannya</p>
            </div>
            <ShieldCheck size={19} color="#168574" />
          </div>

          <ul className="insight-list">
            <li>
              iAQI memakai rata-rata CO selama 24 jam, jadi angkanya berubah
              pelan dan tidak langsung naik saat ada asap sesaat.
            </li>
            <li>
              Kategori mengikuti ISPU: Baik, Sedang, Tidak sehat, Sangat tidak
              sehat, Berbahaya.
            </li>
            <li>
              Sensor MQ-7 berbiaya rendah paling cocok mendeteksi perubahan dan
              lonjakan CO, bukan mengukur konsentrasi rendah dengan presisi
              alat resmi.
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}

// --------------------------------------------------
// STAKEHOLDER ANALYTICS
// --------------------------------------------------

function Analytics({ node, status, readings, hourly, rangeHourly, rangeIaqi, nodes, activeId, range, setRangeId, trend }) {
  const meanTemp = average(readings.map((r) => r.temp));
  const meanHumidity = average(readings.map((r) => r.humidity));
  const long = range.hours > 24;
  const nodeRange = rangeHourly.filter((h) => h.nodeId === activeId);
  const hourlyChart = nodeRange.map((h) => ({
    time: axisLabel(h.hourMs, long),
    avg: h.avgUgm3 != null ? Math.round(h.avgUgm3) : null,
  }));
  const nodeIds = [...new Set(rangeHourly.map((h) => h.nodeId))].sort();
  const compareData = pivotByHour(
    rangeHourly.map((h) => ({ ...h, ugm3: h.avgUgm3 != null ? Math.round(h.avgUgm3) : null })),
    "ugm3",
    long
  );
  // Garis penanda kejadian: dipetakan ke label jam terdekat yang ada di grafik.
  const hourMsSet = new Set(compareData.map((d) => d.hourMs));
  const eventMarks = EVENTS.map((e) => {
    const hourMs = Math.floor(new Date(e.at).getTime() / 3600_000) * 3600_000;
    return hourMsSet.has(hourMs) ? { x: axisLabel(hourMs, long), label: e.label } : null;
  }).filter(Boolean);
  const quality = nodes.map((n) => {
    const rows = rangeHourly.filter((h) => h.nodeId === n.id);
    const samples = rows.reduce((a, h) => a + (h.count ?? 0), 0);
    const hours = rows.filter((h) => (h.count ?? 0) > 0).length;
    return {
      id: n.id,
      hours,
      completeness: Math.min(100, (samples / (range.hours * SAMPLES_PER_HOUR)) * 100),
      testSamples: rows.reduce((a, h) => a + (h.testCount ?? 0), 0),
      lastSeen: n.lastSeen,
    };
  });
  const iaqiNodeIds = [...new Set(rangeIaqi.map((h) => h.nodeId))].sort();
  const iaqiData = pivotByHour(
    rangeIaqi.filter((h) => h.enough && h.iaqi != null),
    "iaqi",
    long
  );
  const envHours = nodeRange.filter((h) => h.avgPpm != null && h.avgTemp != null && h.avgHum != null && h.testCount === 0);
  const tempPairs = envHours.map((h) => ({ x: Number(h.avgTemp.toFixed(1)), y: Number(h.avgPpm.toFixed(2)) }));
  const humPairs = envHours.map((h) => ({ x: Number(h.avgHum.toFixed(0)), y: Number(h.avgPpm.toFixed(2)) }));
  // Perbandingan ppm mentah vs terkoreksi suhu/RH (eksperimental). Muncul hanya jika ada data terkoreksi.
  const compHours = nodeRange.filter((h) => h.avgPpm != null && h.avgPpmComp != null);
  const compData = compHours.map((h) => ({
    label: h.label,
    mentah: Number(h.avgPpm.toFixed(2)),
    terkoreksi: Number(h.avgPpmComp.toFixed(2)),
  }));
  const rTemp = pearson(tempPairs);
  const rHum = pearson(humPairs);
  const recent = [...readings].reverse().slice(0, 15);
  const enough = status?.enough === true && status.iaqi != null;

  return (
    <>
      <div className="section-toolbar">
        <div className="section-label">
          ANALITIK NODE {node ? node.id : ""} <span className="tiny-dot" />
        </div>

        <div className="toolbar-right">
          <div className="range-switch" role="group" aria-label="Rentang waktu">
            {RANGES.map((r) => (
              <button
                key={r.id}
                className={`range-btn ${r.id === range.id ? "active" : ""}`}
                onClick={() => setRangeId(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="metric-grid analytics-metrics">
        <MetricCard
          title="iAQI (CO, 24 jam)"
          value={enough ? status.iaqi : "N/A"}
          suffix=""
          icon={Gauge}
          tone="green"
          change={enough ? status.category : "Data belum cukup"}
        />

        <MetricCard
          title="Rata-rata CO 24 jam"
          value={status?.avgCoUgm3 != null ? Math.round(status.avgCoUgm3) : "—"}
          suffix="µg/m³"
          icon={AirVent}
          tone="purple"
          change={`Batas kategori Baik ${CO_BAIK_LIMIT.toLocaleString("id-ID")} µg/m³`}
        />

        <MetricCard
          title="Jam data valid"
          value={status?.validHours ?? 0}
          suffix="jam"
          icon={Clock3}
          tone="blue"
          change={
            status?.enough
              ? `Syarat minimal ${REQUIRED_HOURS} jam (75%) terpenuhi`
              : `Butuh minimal ${REQUIRED_HOURS} jam (75%)`
          }
        />

        <MetricCard
          title="Suhu rata-rata"
          value={formatNumber(meanTemp)}
          suffix="°C"
          icon={Thermometer}
          tone="orange"
          change={`Lembap rata-rata ${formatNumber(meanHumidity, 0)}%`}
        />
      </div>

      {status?.test && (
        <div className="info-callout warn-callout">
          <ShieldCheck size={18} />
          <div>
            <strong>Berisi data uji</strong>
            <span>
              Ada pembacaan bertanda test:true dalam jendela 24 jam, misalnya
              sebelum R0 dikalibrasi. Hasil iAQI sementara ini bukan hasil
              pengukuran terkalibrasi.
            </span>
          </div>
        </div>
      )}

      <TrendPanel trend={trend} />

      <div className="lower-grid analytics-lower">
        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Rata-rata CO per jam</h2>
              <p>µg/m³, {range.label} terakhir · garis = batas kategori Baik</p>
            </div>
            <span className="chart-note">HOURLY</span>
          </div>
          <ChartBody
            data={hourlyChart}
            dataKey="avg"
            stroke="#b77935"
            suffix=" µg/m³"
            tooltipLabel="Rata-rata CO"
            refLine={CO_BAIK_LIMIT}
            height="small-chart"
          />
        </section>

        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>CO per pembacaan</h2>
              <p>ppm, indikatif</p>
            </div>
            <span className="chart-note">READINGS</span>
          </div>
          <ChartBody
            data={readings}
            dataKey="co"
            stroke="#8564c7"
            suffix=" ppm"
            tooltipLabel="CO"
            height="small-chart"
          />
        </section>

        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Suhu</h2>
              <p>°C</p>
            </div>
            <span className="chart-note">READINGS</span>
          </div>
          <ChartBody
            data={readings}
            dataKey="temp"
            stroke="#168574"
            suffix=" °C"
            tooltipLabel="Suhu"
            height="small-chart"
          />
        </section>

        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Kelembapan</h2>
              <p>% relatif</p>
            </div>
            <span className="chart-note">READINGS</span>
          </div>
          <ChartBody
            data={readings}
            dataKey="humidity"
            stroke="#4d8fd7"
            suffix="%"
            tooltipLabel="Kelembapan"
            height="small-chart"
          />
        </section>
      </div>

      {nodeIds.length > 1 && (
        <section className="panel chart-panel analytics-wide">
          <div className="panel-header">
            <div>
              <h2>Perbandingan antar node</h2>
              <p>Rata-rata CO per jam (µg/m³), {range.label} terakhir. Tiap node punya sensor dan Ro sendiri, jadi bandingkan pola, bukan angka mutlak.</p>
            </div>
            <span className="chart-note">HOURLY</span>
          </div>
          <div className="large-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={compareData} margin={{ top: 10, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="#e9efed" strokeDasharray="4 5" vertical={false} />
                <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#87938f", fontSize: 10 }} minTickGap={28} />
                <YAxis tickLine={false} axisLine={false} tick={{ fill: "#87938f", fontSize: 10 }} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {eventMarks.map((e) => (
                  <ReferenceLine key={e.label + e.x} x={e.x} stroke="#c78338" strokeDasharray="4 4"
                    label={{ value: e.label, fill: "#a97722", fontSize: 10, position: "insideTopLeft" }} />
                ))}
                {nodeIds.map((id, i) => (
                  <Line key={id} type="monotone" dataKey={id} stroke={NODE_COLORS[i % NODE_COLORS.length]} strokeWidth={2} dot={false} connectNulls={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="panel nodes-full-panel quality-panel">
        <div className="panel-header nodes-header">
          <div>
            <h2>Kualitas data</h2>
            <p>Kelengkapan data per node, {range.label} terakhir. Dasar syarat 75 % (≥{REQUIRED_HOURS} dari 24 jam) pada iAQI.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="node-table">
            <thead>
              <tr>
                <th>NODE</th>
                <th>JAM ADA DATA</th>
                <th>KELENGKAPAN SAMPEL</th>
                <th>SAMPEL UJI</th>
                <th>PEMBACAAN TERAKHIR</th>
              </tr>
            </thead>
            <tbody>
              {quality.map((q) => (
                <tr key={q.id}>
                  <td className="table-number">{q.id}</td>
                  <td className="table-number">{q.hours} / {range.hours}</td>
                  <td className="table-number">{q.completeness.toFixed(0)}%</td>
                  <td className="table-number">{q.testSamples}</td>
                  <td className="last-seen">{q.lastSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {quality.length === 0 && <div className="empty-state">Belum ada data.</div>}
        <div className="table-foot">
          <span>Perkiraan 1 sampel tiap 2,5 menit = {SAMPLES_PER_HOUR} sampel per jam.</span>
        </div>
      </section>

      <div className="lower-grid analytics-lower">
        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Suhu vs CO</h2>
              <p>
                Tiap titik = rata-rata satu jam ({tempPairs.length} jam).{" "}
                {rTemp == null ? "Butuh ≥6 jam data" : `Korelasi r = ${rTemp.toFixed(2)}`}
              </p>
            </div>
            <span className="chart-note">SCATTER</span>
          </div>
          <ScatterPanel data={tempPairs} xName="Suhu" xUnit="°C" color="#c78338" />
        </section>

        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Kelembapan vs CO</h2>
              <p>
                Tiap titik = rata-rata satu jam ({humPairs.length} jam).{" "}
                {rHum == null ? "Butuh ≥6 jam data" : `Korelasi r = ${rHum.toFixed(2)}`}
              </p>
            </div>
            <span className="chart-note">SCATTER</span>
          </div>
          <ScatterPanel data={humPairs} xName="Kelembapan" xUnit="%" color="#4d8fd7" />
        </section>
      </div>

      {compData.length >= 2 && (
        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>ppm mentah vs terkoreksi suhu/RH</h2>
              <p>Rata-rata per jam ({compData.length} jam). Koreksi eksperimental: koefisien awal dari kurva datasheet MQ-7 (Fig. 4), diganti hasil fit data udara bersih setelah data cukup.</p>
            </div>
            <span className="chart-note">EKSPERIMENTAL</span>
          </div>
          <div className="small-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={compData} margin={{ top: 10, right: 8, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="#e9efed" strokeDasharray="4 5" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#87938f", fontSize: 10 }} minTickGap={24} />
                <YAxis tickLine={false} axisLine={false} tick={{ fill: "#87938f", fontSize: 10 }} unit=" ppm" />
                <Tooltip />
                <Line type="monotone" dataKey="mentah" name="Mentah" stroke="#87938f" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="terkoreksi" name="Terkoreksi" stroke="#1f8a70" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <div className="info-callout">
        <ShieldCheck size={18} />
        <div>
          <strong>Cara membaca scatter</strong>
          <span>
            Kalau titik membentuk pola miring jelas dan korelasi |r| besar pada udara yang sama bersihnya,
            CO terbaca ikut berubah karena suhu atau kelembapan, bukan karena gas. Ini dasar koreksi suhu/RH.
            Korelasi baru berarti kalau suhu dan RH bervariasi lebar (hujan, malam, AC) dan datanya cukup banyak.
          </span>
        </div>
      </div>

      {iaqiNodeIds.length > 0 && (
        <section className="panel chart-panel analytics-wide">
          <div className="panel-header">
            <div>
              <h2>Riwayat iAQI</h2>
              <p>Hanya jam saat data sudah cukup (≥{REQUIRED_HOURS} jam valid), {range.label} terakhir</p>
            </div>
            <span className="chart-note">iAQI</span>
          </div>
          {iaqiData.length > 0 ? (
            <div className="small-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={iaqiData} margin={{ top: 10, right: 8, left: -14, bottom: 0 }}>
                  <CartesianGrid stroke="#e9efed" strokeDasharray="4 5" vertical={false} />
                  <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fill: "#87938f", fontSize: 10 }} minTickGap={28} />
                  <YAxis domain={[0, (m) => Math.max(60, Math.ceil(m * 1.2))]} tickLine={false} axisLine={false} tick={{ fill: "#87938f", fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={50} stroke="#c0392b" strokeDasharray="5 4" label={{ value: "Batas Baik", fill: "#c0392b", fontSize: 10, position: "insideTopRight" }} />
                  {iaqiNodeIds.map((id, i) => (
                    <Line key={id} type="monotone" dataKey={id} stroke={NODE_COLORS[i % NODE_COLORS.length]} strokeWidth={2} dot={false} connectNulls={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="small-chart chart-empty">Belum ada jam dengan data cukup untuk dihitung iAQI-nya.</div>
          )}
        </section>
      )}

      <section className="panel nodes-full-panel recent-panel">
        <div className="panel-header nodes-header">
          <div>
            <h2>Pembacaan terbaru</h2>
            <p>15 pembacaan terakhir dari node ini</p>
          </div>
        </div>

        <div className="table-scroll">
          <table className="node-table">
            <thead>
              <tr>
                <th>WAKTU</th>
                <th>SUHU</th>
                <th>KELEMBAPAN</th>
                <th>CO MENTAH (PPM)</th>
                <th>CO TERKOREKSI (PPM)</th>
                <th>JENIS DATA</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td className="last-seen">{formatDateTime(r.createdMs)}</td>
                  <td className="table-number">
                    {r.temp == null ? "—" : `${r.temp.toFixed(1)} °C`}
                  </td>
                  <td className="table-number">
                    {r.humidity == null ? "—" : `${r.humidity.toFixed(0)}%`}
                  </td>
                  <td className="table-number">
                    {r.co == null ? "—" : r.co.toFixed(2)}
                  </td>
                  <td className="table-number">
                    {r.coComp == null ? "—" : r.coComp.toFixed(2)}
                  </td>
                  <td>
                    <span
                      className={`status-pill ${r.test || r.warmup ? "status-warning" : "status-online"}`}
                    >
                      <i />
                      {r.test ? "Uji" : r.warmup ? "Pemanasan" : "Terukur"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {recent.length === 0 && (
          <div className="empty-state">Belum ada pembacaan untuk node ini.</div>
        )}
      </section>

      <div className="info-callout">
        <ShieldCheck size={18} />
        <div>
          <strong>Catatan interpretasi</strong>
          <span>
            iAQI hanya memakai CO dan baru dihitung setelah minimal 18 dari 24
            jam punya data. Konversi ppm ke µg/m³ memakai suhu dari DHT22 pada 1
            atm (asumsi, peraturan tidak menyebut kondisi acuan). Hasil
            sebaiknya dibandingkan dengan alat referensi sebelum dipakai untuk
            keputusan.
          </span>
        </div>
      </div>
    </>
  );
}

// --------------------------------------------------
// MONITORING NODES PAGE
// --------------------------------------------------

function Nodes({ search, setSearch, filteredNodes, totalNodes, onlineCount }) {
  const filteredOnline = filteredNodes.filter((n) => n.status === "Online").length;

  return (
    <>
      <div className="section-toolbar">
        <div className="section-label">
          DEVICE INVENTORY <span className="tiny-dot" />
        </div>

        <div className="toolbar-right">
          <span className="node-total">
            {filteredNodes.length} of {totalNodes} nodes
          </span>
        </div>
      </div>

      <div className="metric-grid">
        <MetricCard
          title="Matching nodes"
          value={filteredNodes.length}
          suffix=""
          icon={RadioTower}
          tone="green"
          change="Based on current search"
        />

        <MetricCard
          title="Online nodes"
          value={filteredOnline}
          suffix=""
          icon={Wifi}
          tone="blue"
          change="Pesan diterima dalam 10 menit terakhir"
        />

        <MetricCard
          title="Offline nodes"
          value={filteredNodes.length - filteredOnline}
          suffix=""
          icon={Activity}
          tone="orange"
          change={`${onlineCount} of ${totalNodes} online di seluruh jaringan`}
        />
      </div>

      <section className="panel nodes-full-panel">
        <div className="panel-header nodes-header">
          <div>
            <h2>All monitoring nodes</h2>
            <p>Node yang pernah mengirim data ke Firestore</p>
          </div>
        </div>

        <div className="table-tools">
          <label className="search-box">
            <Search size={16} />

            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by node ID, location, or area..."
              aria-label="Cari node"
            />

            {search && (
              <button
                className="icon-button"
                aria-label="Hapus pencarian"
                onClick={() => setSearch("")}
              >
                <X size={15} />
              </button>
            )}
          </label>

          <button className="button button-secondary" onClick={() => setSearch("")}>
            Clear filters
          </button>
        </div>

        <NodeTable nodes={filteredNodes} />

        {filteredNodes.length === 0 && (
          <div className="empty-state">
            Tidak ada node yang cocok, atau belum ada node yang mengirim data.
          </div>
        )}

        <div className="table-foot">
          <span>
            Showing <strong>{filteredNodes.length}</strong> of {totalNodes} nodes
          </span>

          <span>Status online/offline dihitung dari waktu pesan terakhir.</span>
        </div>
      </section>
    </>
  );
}

// --------------------------------------------------
// REUSABLE COMPONENTS
// --------------------------------------------------

// --------------------------------------------------
// METODOLOGI (cara iAQI dihitung, batasan, dan asumsi)
// --------------------------------------------------

const METHOD_BREAKPOINTS = [
  { key: "baik", label: "Baik", ispu: "0 – 50", co: "sampai 4.000" },
  { key: "sedang", label: "Sedang", ispu: "51 – 100", co: "4.001 – 8.000" },
  { key: "tidak-sehat", label: "Tidak sehat", ispu: "101 – 200", co: "8.001 – 15.000" },
  { key: "sangat", label: "Sangat tidak sehat", ispu: "201 – 300", co: "15.001 – 30.000" },
  { key: "berbahaya", label: "Berbahaya", ispu: "301 – 500", co: "30.001 ke atas" },
];

function Methodology() {
  return (
    <>
      <section className="panel method-panel">
        <div className="panel-header">
          <div>
            <h2>Alur data</h2>
            <p>Dari sensor sampai tampil di dashboard</p>
          </div>
        </div>

        <div className="method-flow">
          {["Node sensor", "MQTT (EMQX)", "Webhook (Vercel)", "Firestore", "Dashboard web"].map((label, i, arr) => (
            <React.Fragment key={label}>
              <span className="method-step">{label}</span>
              {i < arr.length - 1 && <span className="method-arrow">→</span>}
            </React.Fragment>
          ))}
        </div>
        <p className="method-note">
          Tiap node mengukur CO (MQ-7), suhu, dan kelembapan (DHT22) lalu mengirimnya sekitar tiap 2,5 menit
          lewat MQTT. Broker meneruskan tiap pesan ke fungsi server (webhook) yang memvalidasi nilainya, menyimpannya
          ke Firestore, lalu menghitung iAQI. Dashboard menampilkan hasilnya secara langsung. Tidak ada komputer
          pribadi yang harus menyala.
        </p>
      </section>

      <div className="method-grid">
        <section className="panel method-panel">
          <div className="panel-header">
            <div>
              <h2>Cara iAQI dihitung</h2>
              <p>Mengikuti Permen LHK No. P.14 Tahun 2020 (ISPU)</p>
            </div>
          </div>

          <ol className="method-list">
            <li>
              <strong>Ukur CO.</strong> Sensor MQ-7 dibaca di akhir fase pemanas bersuhu rendah, lalu
              dikonversi ke ppm memakai kalibrasi Ro di udara bersih.
            </li>
            <li>
              <strong>Ubah satuan.</strong> ppm menjadi µg/m³: ppm × 28,01 × 1000 ÷ Vm, dengan Vm volume molar
              gas pada suhu node (dari DHT22) dan tekanan 1 atm.
            </li>
            <li>
              <strong>Rata-ratakan.</strong> Nilai dirata-rata per jam, lalu rata-rata dari jam-jam dalam 24 jam
              terakhir.
            </li>
            <li>
              <strong>Cek kecukupan data.</strong> Minimal {REQUIRED_HOURS} dari 24 jam (75%) harus punya data.
              Satu jam dihitung valid kalau ada minimal satu pembacaan terukur di jam itu. Kalau kurang, iAQI
              tidak dihitung dan tampil "Data belum cukup".
            </li>
            <li>
              <strong>Hitung indeks.</strong> Interpolasi linear antar titik batas:
              <code className="method-formula">I = (Ia − Ib) / (Xa − Xb) × (Xx − Xb) + Ib</code>
            </li>
          </ol>
        </section>

        <section className="panel method-panel">
          <div className="panel-header">
            <div>
              <h2>Kategori dan batas CO</h2>
              <p>CO rata-rata 24 jam, satuan µg/m³</p>
            </div>
          </div>

          <div className="table-scroll">
            <table className="node-table">
              <thead>
                <tr>
                  <th>KATEGORI</th>
                  <th>RENTANG ISPU</th>
                  <th>CO (µg/m³)</th>
                </tr>
              </thead>
              <tbody>
                {METHOD_BREAKPOINTS.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <span className={`aqi-category cat-chip-${row.key} method-chip`}>{row.label}</span>
                    </td>
                    <td className="table-number">{row.ispu}</td>
                    <td className="table-number">{row.co}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel method-panel">
        <div className="panel-header">
          <div>
            <h2>Batasan dan asumsi</h2>
            <p>Supaya angka dibaca dengan tepat</p>
          </div>
          <ShieldCheck size={19} color="#168574" />
        </div>

        <ul className="insight-list">
          <li>
            iAQI di sini <strong>indikatif</strong>. Sensor MQ-7 berbiaya rendah, sehingga sistem ini
            melengkapi, bukan menggantikan, stasiun pemantau resmi.
          </li>
          <li>
            Nilai ppm memakai kurva dari datasheet dan kalibrasi Ro per node di udara bersih. Belum
            dibandingkan dengan alat ukur referensi.
          </li>
          <li>
            Pengaruh suhu dan kelembapan terhadap MQ-7 (Fig. 4 datasheet) dianalisis dari data udara bersih
            tiap node. Koreksi <strong>eksperimental</strong>: Rs dibagi exp(a·ΔT + b·ΔRH) dengan koefisien
            per node, lalu dikonversi ke ppm. Nilai mentah selalu disimpan dan dapat dibandingkan di
            Analytics. iAQI memakai nilai terkoreksi hanya pada node yang koefisiennya sudah divalidasi;
            selain itu iAQI memakai nilai mentah.
          </li>
          <li>
            Sensor MQ-7 butuh waktu pemanasan. Setelah node baru menyala (atau lama mati), pembacaan 60 menit
            pertama ditandai "Pemanasan" dan tidak dihitung ke rata-rata jam maupun iAQI.
          </li>
          <li>iAQI hanya dihitung dari CO. Polutan lain (PM2.5, PM10, O₃, NO₂, SO₂) belum diukur.</li>
          <li>
            Asumsi perhitungan: batas bawah segmen pertama 0 µg/m³ dan nilai indeks ditahan di 500, karena
            peraturan tidak menuliskan keduanya untuk CO. Konversi satuan memakai tekanan 1 atm.
          </li>
          <li>Data yang dikirim sebelum kalibrasi selesai ditandai "DATA UJI" dan tidak dianggap pengukuran sah.</li>
          <li>
            Node dianggap <strong>offline</strong> kalau tidak ada pesan lebih dari{" "}
            {Math.round(OFFLINE_AFTER_MS / 60000)} menit.
          </li>
        </ul>
      </section>
    </>
  );
}

function ScatterPanel({ data, xName, xUnit, color }) {
  if (data.length < 2) {
    return <div className="small-chart chart-empty">Belum cukup data per jam.</div>;
  }
  return (
    <div className="small-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 10, right: 12, left: -10, bottom: 0 }}>
          <CartesianGrid stroke="#e9efed" strokeDasharray="4 5" />
          <XAxis type="number" dataKey="x" name={xName} unit={xUnit} domain={["auto", "auto"]} tickLine={false} axisLine={false} tick={{ fill: "#87938f", fontSize: 10 }} />
          <YAxis type="number" dataKey="y" name="CO" unit=" ppm" domain={["auto", "auto"]} tickLine={false} axisLine={false} tick={{ fill: "#87938f", fontSize: 10 }} />
          <Tooltip cursor={{ strokeDasharray: "3 3" }} />
          <Scatter data={data} fill={color} fillOpacity={0.75} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function TrendPanel({ trend }) {
  const Icon = trend?.direction === "naik" ? ArrowUpRight : trend?.direction === "turun" ? ArrowDownRight : Minus;
  return (
    <section className="panel trend-panel">
      <div className="panel-header">
        <div>
          <h2>Proyeksi tren CO</h2>
          <p>Arah perubahan dari data per jam</p>
        </div>
        <span className={`trend-icon trend-${trend?.direction ?? "none"}`}>
          <Icon size={20} />
        </span>
      </div>

      {trend ? (
        <>
          <div className="trend-main">
            CO cenderung <strong>{trend.direction}</strong>
            <span>
              {trend.pct >= 0 ? "+" : ""}
              {trend.pct.toFixed(0)}%
            </span>
          </div>
          <p className="trend-sub">
            Rata-rata 3 jam terakhir {Math.round(trend.recent)} µg/m³ dibanding{" "}
            {Math.round(trend.before)} µg/m³ pada 3 jam sebelumnya.
          </p>
        </>
      ) : (
        <p className="trend-sub">
          Butuh minimal 6 jam data per jam yang berurutan (dalam rentang 8 jam) untuk menilai tren.
        </p>
      )}
      <p className="trend-note">
        Ini indikasi arah dari data terukur, bukan prediksi nilai di masa depan.
      </p>
    </section>
  );
}

function ChartBody({
  data,
  dataKey,
  stroke,
  suffix = "",
  tooltipLabel,
  refLine,
  loading = false,
  height = "small-chart",
}) {
  const hasData = data.some((d) => d[dataKey] != null);
  const gradId = `fill-${dataKey}-${stroke.slice(1)}`;
  const yDomain = refLine
    ? [0, (dataMax) => Math.max(Math.ceil(dataMax * 1.2), Math.ceil(refLine * 1.1))]
    : ["auto", "auto"];

  if (!hasData) {
    return (
      <div className={`${height} chart-empty`}>
        {loading ? "Memuat data..." : "Belum ada data untuk ditampilkan."}
      </div>
    );
  }

  return (
    <div className={height}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 8, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.2} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="#e9efed" strokeDasharray="4 5" vertical={false} />

          <XAxis
            dataKey="time"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#87938f", fontSize: 10 }}
            minTickGap={24}
          />

          <YAxis
            domain={yDomain}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#87938f", fontSize: 10 }}
          />

          <Tooltip formatter={(value) => [`${value}${suffix}`, tooltipLabel]} />

          {refLine && (
            <ReferenceLine
              y={refLine}
              stroke="#c0392b"
              strokeDasharray="5 4"
              label={{ value: "Batas Baik", fill: "#c0392b", fontSize: 10, position: "insideTopRight" }}
            />
          )}

          <Area
            type="monotone"
            dataKey={dataKey}
            name={tooltipLabel}
            stroke={stroke}
            fill={`url(#${gradId})`}
            strokeWidth={2.2}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function MetricCard({ title, value, suffix, icon: Icon, tone, change }) {
  return (
    <section className="metric-card">
      <div className="metric-top">
        <span>{title}</span>

        <div className={`metric-icon ${tone}`}>
          <Icon size={18} />
        </div>
      </div>

      <div className="metric-value">
        {value}
        <small>{suffix}</small>
      </div>

      <div className="metric-bottom">
        <span className={`metric-line ${tone}`}>
          <span />
        </span>

        <span>{change}</span>
      </div>
    </section>
  );
}

function NodeTable({ nodes }) {
  return (
    <div className="table-scroll">
      <table className="node-table">
        <thead>
          <tr>
            <th>NODE / LOCATION</th>
            <th>STATUS</th>
            <th>LAST SEEN</th>
            <th>TEMPERATURE</th>
            <th>HUMIDITY</th>
            <th>CO (PPM)</th>
            <th>AREA</th>
          </tr>
        </thead>

        <tbody>
          {nodes.map((node) => (
            <tr key={node.id}>
              <td>
                <div className="node-cell">
                  <div className="node-device">
                    <RadioTower size={17} />
                  </div>

                  <div>
                    <strong>{node.id}</strong>
                    <span>{node.name}</span>
                  </div>
                </div>
              </td>

              <td>
                <span
                  className={`status-pill ${
                    node.status === "Online" ? "status-online" : "status-offline"
                  }`}
                >
                  <i />
                  {node.status}
                </span>
              </td>

              <td className="last-seen">{node.lastSeen}</td>

              <td className="table-number">
                {node.temp == null ? "—" : `${node.temp.toFixed(1)} °C`}
              </td>

              <td className="table-number">
                {node.humidity == null ? "—" : `${node.humidity.toFixed(0)}%`}
              </td>

              <td className="table-number">
                {node.co == null ? "—" : node.co.toFixed(2)}
                {node.test && <span className="tag tag-test inline-tag">UJI</span>}
              </td>

              <td>{node.area}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;

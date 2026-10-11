import { useSensorReadings } from "./useSensorReadings";
import { useEffect } from "react";
import { testFirebase } from "./testFirebase";
import React, { useMemo, useState } from "react";
import * as XLSX from "xlsx";

import {
  Activity,
  AirVent,
  ArrowUpRight,
  Bell,
  ChevronDown,
  CircleHelp,
  Clock3,
  Cloud,
  CloudSun,
  Download,
  Gauge,
  LayoutDashboard,
  MapPin,
  Menu,
  RadioTower,
  RefreshCw,
  Search,
  Settings2,
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
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { mockNodes, mockReadings } from "./data/mockData";

const navItems = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "analytics", label: "Analytics", icon: Activity },
  { id: "nodes", label: "Monitoring Nodes", icon: RadioTower },
];

const ranges = ["Hari ini", "7 hari terakhir", "30 hari terakhir"];

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

// --------------------------------------------------
// EXCEL EXPORT
// Creates two worksheets: Nodes and Readings.
// All exported values are demo/simulation data.
// --------------------------------------------------

function downloadExcel(filename, nodes, readings) {
  const nodeRows = nodes.map((node) => ({
    "Node ID": node.id,
    Location: node.name,
    Area: node.area,
    Status: node.status,
    "Last Seen": node.lastSeen,
    "Temperature (°C)": node.temp ?? "",
    "Humidity (%)": node.humidity ?? "",
    "CO Reading (simulated)": node.co ?? "Tidak tersedia",
    "Data Type": "Simulasi",
  }));

  const readingRows = readings.map((reading) => ({
    Time: reading.time,
    "Temperature (°C)": reading.temp ?? "",
    "Humidity (%)": reading.humidity ?? "",
    "CO Reading (simulated)": reading.co ?? "",
    "Data Type": "Simulasi",
  }));

  const workbook = XLSX.utils.book_new();

  const nodesSheet = XLSX.utils.json_to_sheet(nodeRows);
  const readingsSheet = XLSX.utils.json_to_sheet(readingRows);

  nodesSheet["!cols"] = [
    { wch: 14 },
    { wch: 26 },
    { wch: 16 },
    { wch: 12 },
    { wch: 18 },
    { wch: 18 },
    { wch: 16 },
    { wch: 27 },
    { wch: 14 },
  ];

  readingsSheet["!cols"] = [
    { wch: 12 },
    { wch: 20 },
    { wch: 16 },
    { wch: 27 },
    { wch: 14 },
  ];

  // Freeze the header row for easier scrolling in Excel.
  nodesSheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  readingsSheet["!freeze"] = { xSplit: 0, ySplit: 1 };

  // Add filters to the column headings.
  if (nodeRows.length > 0) {
    nodesSheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: nodeRows.length, c: Object.keys(nodeRows[0]).length - 1 },
      }),
    };
  }

  if (readingRows.length > 0) {
    readingsSheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: {
          r: readingRows.length,
          c: Object.keys(readingRows[0]).length - 1,
        },
      }),
    };
  }

  XLSX.utils.book_append_sheet(workbook, nodesSheet, "Nodes");
  XLSX.utils.book_append_sheet(workbook, readingsSheet, "Readings");

  XLSX.writeFile(workbook, filename);
}

// --------------------------------------------------
// MAIN APP
// --------------------------------------------------

function App() {
  const {
  readings: firebaseReadings,
  loading: readingsLoading,
  error: readingsError,
} = useSensorReadings();
  

const chartReadings = useMemo(() => {
  return firebaseReadings
    .map((item) => ({
      ...item,
       nodeId: item.nodeId ?? "UNKNOWN",
      temp:
        item.temp != null
          ? Number(item.temp)
          : item.temperature != null
            ? Number(item.temperature)
            : null,
      humidity:
        item.humidity != null
          ? Number(item.humidity)
          : null,
      co:
        item.co != null
          ? Number(item.co)
          : null,
      time: item.time ?? "",
    }))
    .map((item) => ({
      ...item,
      temp: Number.isFinite(item.temp) ? item.temp : null,
      humidity: Number.isFinite(item.humidity)
        ? item.humidity
        : null,
      co: Number.isFinite(item.co) ? item.co : null,
    }))
    .sort((a, b) =>
      String(a.time).localeCompare(String(b.time))
    );
}, [firebaseReadings]);


  const [page, setPage] = useState("overview");
  const [range, setRange] = useState("Hari ini");
  const [search, setSearch] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [notice, setNotice] = useState("");

 const firestoreNodes = useMemo(() => {
  const nodeMap = new Map();

  chartReadings.forEach((reading) => {
    if (!reading.nodeId || reading.nodeId === "UNKNOWN") return;

    const existing = nodeMap.get(reading.nodeId);

    // Ambil pembacaan terbaru berdasarkan waktu.
    if (
      !existing ||
      String(reading.time).localeCompare(String(existing.time)) > 0
    ) {
      nodeMap.set(reading.nodeId, reading);
    }
  });

  return Array.from(nodeMap.values()).map((reading) => ({
    id: reading.nodeId,
    name: reading.location ?? reading.nodeId,
    area: reading.area ?? "Belum ditentukan",
    status: "Data diterima",
    lastSeen: reading.time || "Waktu belum tersedia",
    temp: reading.temp,
    humidity: reading.humidity,
    time: reading.time,
  }));
}, [chartReadings]);

const filteredNodes = useMemo(() => {
  const query = search.trim().toLowerCase();

  return firestoreNodes.filter((node) =>
    `${node.id} ${node.name} ${node.area} ${node.status}`
      .toLowerCase()
      .includes(query)
  );
}, [firestoreNodes, search]);

const onlineNodes = filteredNodes;

 
const averageTemp = average(
  chartReadings.map((reading) => reading.temp)
);

const averageHumidity = average(
  chartReadings.map((reading) => reading.humidity)
);

const environmentalStatus =
  averageTemp == null || averageHumidity == null
    ? {
        label: "Data belum lengkap",
        color: "neutral",
      }
    : averageTemp > 35 || averageHumidity > 80
      ? {
          label: "Perlu perhatian",
          color: "warning",
        }
      : {
          label: "Kondisi terpantau",
          color: "normal",
        };



  const availability = mockNodes.length
    ? (onlineNodes.length / mockNodes.length) * 100
    : 0;

  const refresh = () => {
    setLastUpdated(new Date());
    setNotice(
      "Tampilan diperbarui. Data sensor masih menggunakan simulasi."
    );
  };

  const exportReport = () => {
    try {
      downloadExcel(
        "bali-airwatch-simulation-report.xlsx",
        mockNodes,
        mockReadings
      );

      setNotice(
        "Laporan Excel berhasil dibuat. Semua data merupakan simulasi."
      );
    } catch (error) {
      console.error("Export Excel gagal:", error);

      setNotice(
        "Export Excel gagal. Pastikan package xlsx sudah terpasang."
      );
    }
  };

  const openSettings = () => {
    setNotice(
      "Pengaturan perangkat tersedia setelah backend dibuat."
    );
  };

  const openHelp = () => {
    setNotice(
      "Bali AirWatch adalah prototipe dengan data sensor simulasi."
    );
  };
  useEffect(() => {
  testFirebase();
}, []);

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

              {id === "nodes" && (
                <span className="nav-count">{firestoreNodes.length}</span>
              )}
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

          <button className="nav-item utility" onClick={openSettings}>
            <Settings2 size={18} />
            <span>Settings</span>
          </button>

          <button className="nav-item utility" onClick={openHelp}>
            <CircleHelp size={18} />
            <span>Help &amp; documentation</span>
          </button>

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
            <strong>
              {navItems.find((item) => item.id === page)?.label}
            </strong>
          </div>

          <div className="topbar-actions">
            <div className="environment-pill">
              <span className="environment-dot" />
              <span>SIMULATION MODE</span>
            </div>

            <button
              className="icon-button notification-button"
              aria-label="Informasi simulasi"
              title="Informasi simulasi"
              onClick={openHelp}
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
                  ? "Air Quality Overview"
                  : page === "analytics"
                    ? "Analytics & Trends"
                    : "Monitoring Nodes"}
              </h1>

              <p>
                {page === "overview"
                  ? "Pantau kondisi udara dan status jaringan sensor di Bali."
                  : page === "analytics"
                    ? "Jelajahi tren pembacaan sensor dari waktu ke waktu."
                    : "Kelola dan pantau status perangkat sensor terdistribusi."}
              </p>
            </div>

            <div className="heading-actions">
              <button className="button button-secondary" onClick={refresh}>
                <RefreshCw size={15} />
                Refresh
              </button>

              <button
                className="button button-primary"
                onClick={exportReport}
              >
                <Download size={15} />
                Export report
              </button>
            </div>
          </div>

         
            <div className="simulation-banner">
              <div className="sim-icon">
                <ShieldCheck size={18} />
              </div>

              <div>
                <strong>Mode prototipe aktif</strong>
                <span>
                  Suhu dan kelembapan dibaca dari Firestore.
                  Data perangkat sensor dan pengukuran CO
                  belum terverifikasi.
                </span>
              </div>

              <span className="sim-tag">PROTOTYPE</span>
            </div>

          
{readingsLoading && (
  <div className="info-callout">
    Memuat data sensor dari Firestore...
  </div>
)}

{readingsError && (
  <div className="info-callout" role="alert">
    Gagal memuat Firestore: {readingsError}
  </div>
)}

{!readingsLoading && !readingsError && (
  <div className="info-callout">
    <strong>Data Firestore</strong>
  <span>
    Jumlah pembacaan: {chartReadings.length}
  </span>

  {chartReadings.map((reading) => (
    <div key={reading.id}>
      Node: {reading.nodeId} | Suhu: {reading.temp ?? "—"} °C |
      Kelembapan: {reading.humidity ?? "—"}%
    </div>
  ))}
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
            <Overview
              readingsLoading={readingsLoading}
              readingsError={readingsError}
              environmentalStatus={environmentalStatus}
              range={range}
              setRange={setRange}
              filteredNodes={filteredNodes}
              onlineNodes={onlineNodes}
              averageTemp={averageTemp}
              averageHumidity={averageHumidity}
              availability={availability}
              chartReadings={chartReadings}
              lastUpdated={lastUpdated}
              setPage={setPage}
            />
          )}

          {page === "analytics" && (
           
<Analytics
  range={range}
  setRange={setRange}
  chartReadings={chartReadings}
/>

          )}

          {page === "nodes" && (
         <Nodes
              search={search}
              setSearch={setSearch}
              filteredNodes={filteredNodes}
              totalNodes={firestoreNodes.length}
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
// OVERVIEW PAGE
// --------------------------------------------------

function Overview({
  readingsLoading,
  readingsError,
  environmentalStatus,
  range,
  setRange,
  filteredNodes,
  onlineNodes,
  averageTemp,
  averageHumidity,
  availability,
  chartReadings,
  lastUpdated,
  setPage,
}) {
  return (
    <>
      <div className="section-toolbar">
        <div className="section-label">
          NETWORK SUMMARY <span className="tiny-dot" />
        </div>

        <div className="toolbar-right">
          <span className="updated-text">
            <Clock3 size={14} />
            Updated{" "}
            {lastUpdated.toLocaleTimeString("id-ID", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>

          <RangeSelect range={range} setRange={setRange} />
        </div>
      </div>

      <div className="metric-grid">
              <MetricCard
                title="Connected sensor readings"
                value={readingsLoading ? "..." : chartReadings.length}
                suffix=""
                icon={RadioTower}
                tone="green"
                change={
                  readingsError
                    ? "Firestore gagal dibaca"
                    : "Jumlah dokumen Firestore, bukan jumlah node fisik"
                }
              />

        <MetricCard
          title="Temperature average"
          value={formatNumber(averageTemp)}
          suffix="°C"
          icon={Thermometer}
          tone="orange"
          change="Rata-rata data Firestore"
        />

        <MetricCard
          title="Humidity average"
          value={formatNumber(averageHumidity)}
          suffix="%"
          icon={Droplets}
          tone="blue"
          change="Rata-rata data Firestore"
        />

       
          <MetricCard
            title="MQ-7 carbon monoxide"
            value="Belum terverifikasi"
            suffix=""
            icon={AirVent}
            tone="purple"
            change="Satuan dan kalibrasi belum diketahui"
          />

      </div>

      <div className="main-grid">
        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <h2>Sensor readings trend</h2>
             <p>Tren suhu berdasarkan pembacaan Firestore</p>
            </div>

            <button
              className="text-button"
              onClick={() => setPage("analytics")}
            >
              View analytics <ArrowUpRight size={15} />
            </button>
          </div>

          <div className="chart-legend">
            <span>
              <i className="legend-dot teal" />
              Temperature <b>°C</b>
            </span>

            <span className="chart-note">FIRESTORE DATA</span>
          </div>

          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartReadings}
                margin={{ top: 12, right: 6, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient
                    id="tempFill"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      stopColor="#168574"
                      stopOpacity={0.18}
                    />
                    <stop
                      offset="95%"
                      stopColor="#168574"
                      stopOpacity={0.01}
                    />
                  </linearGradient>
                </defs>

                <CartesianGrid
                  stroke="#e9efed"
                  strokeDasharray="4 5"
                  vertical={false}
                />

                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#87938f", fontSize: 11 }}
                  dy={10}
                />

                <YAxis
                  domain={["dataMin - 1", "dataMax + 1"]}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "#87938f", fontSize: 11 }}
                />

                <Tooltip
                  formatter={(value) => [`${value} °C`, "Temperature"]}
                />

                <Area
                  type="monotone"
                  dataKey="temp"
                  name="Temperature"
                  stroke="#168574"
                  strokeWidth={2.5}
                  fill="url(#tempFill)"
                  activeDot={{ r: 5, strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="chart-footer">
            <span>
              <span className="legend-dot teal" />
              Pembacaan tersimpan di Firestore
            </span>
            <span>Belum tentu data sensor fisik</span>
          </div>
        </section>

        <section className="panel conditions-panel">
          <div className="panel-header">
            <div>
              <h2>Environmental conditions</h2>
              <p>Sample from simulated nodes</p>
            </div>

            <span className="weather-icon">
              <CloudSun size={21} />
            </span>
          </div>

          <div className="condition-primary">
            <div>
              <span className="condition-label">Temperature</span>

              <div className="condition-number">
                {formatNumber(averageTemp)}
                <span>°C</span>
              </div>

              <span className="condition-foot">
                Average of online demo nodes
              </span>
            </div>

            <div className="thermo-illustration">
              <Thermometer size={30} />
            </div>
          </div>

          <div className="condition-divider" />

          <div className="humidity-row">
            <div className="humidity-icon">
              <Droplets size={18} />
            </div>

            <div className="humidity-copy">
              <strong>Relative humidity</strong>
              <span>Average simulated reading</span>
            </div>

            <div className="humidity-value">
              {formatNumber(averageHumidity, 0)}
              <span>%</span>
            </div>
          </div>

          <div className="humidity-track">
            <span
              style={{
                width: `${Math.min(
                  100,
                  Math.max(0, averageHumidity ?? 0)
                )}%`,
              }}
            />
          </div>

          <div className="condition-bottom">
            <span>
              <Cloud size={14} />
              Weather conditions are not measured directly
            </span>
          </div>
        </section>
      </div>

      <div className="lower-grid">
        <section className="panel nodes-panel">
          <div className="panel-header">
            <div>
              <h2>Monitoring nodes</h2>
              <p>Latest device status across the network</p>
            </div>

            <button
              className="text-button"
              onClick={() => setPage("nodes")}
            >
              View all nodes <ArrowUpRight size={15} />
            </button>
          </div>

          <NodeTable nodes={filteredNodes.slice(0, 3)} compact />
        </section>

        <section className="panel network-panel">
          <div className="panel-header">
            <div>
              <h2>Network health</h2>
              <p>Connectivity overview</p>
            </div>

            <div className="network-icon">
              <Wifi size={18} />
            </div>
          </div>

          <div className="network-score">
            <strong>
              {availability.toFixed(1)}
              <span>%</span>
            </strong>

            <span
              className={`status-pill ${
                availability === 100 ? "status-online" : "status-warning"
              }`}
            >
              {availability === 100
                ? "All nodes online"
                : "Partial availability"}
            </span>
          </div>

          <div className="network-track">
            <span style={{ width: `${availability}%` }} />
          </div>

          <div className="network-stats">
            <div>
              <span className="status-dot online" />
              Online <strong>{onlineNodes.length}</strong>
            </div>

            <div>
              <span className="status-dot offline" />
              Offline <strong>{mockNodes.length - onlineNodes.length}</strong>
            </div>
          </div>

          <div className="network-note">
            <Activity size={15} />
            <span>
              Availability is calculated from the simulated node list.
            </span>
          </div>
        </section>
      </div>
    </>
  );
}

// --------------------------------------------------
// ANALYTICS PAGE
// --------------------------------------------------

function Analytics({ range, setRange, chartReadings }) {
  const meanTemp = average(chartReadings.map((item) => item.temp));
  const meanHumidity = average(chartReadings.map((item) => item.humidity));
  const meanCO = average(chartReadings.map((item) => item.co));

  const chartConfig = [
    {
      title: "Temperature over time",
      subtitle: "Suhu · °C",
      dataKey: "temp",
      stroke: "#168574",
      fill: "#168574",
      suffix: " °C",
    },
    {
      title: "Humidity trend",
      subtitle: "Kelembapan relatif · %",
      dataKey: "humidity",
      stroke: "#4d8fd7",
      fill: "#4d8fd7",
      suffix: "%",
    },
    {
      title: "CO reading trend",
      subtitle: "Nilai CO simulasi · bukan ppm terkalibrasi",
      dataKey: "co",
      stroke: "#b77935",
      fill: "#b77935",
      suffix: "",
    },
  ];

  return (
    <>
      <div className="section-toolbar">
        <div className="section-label">HISTORICAL ANALYTICS</div>

        <div className="toolbar-right">
          <RangeSelect range={range} setRange={setRange} />
        </div>
      </div>

      <div className="info-callout">
        <ShieldCheck size={18} />

        <div>
          <strong>Data availability</strong>
          <span>
            Dataset ini hanya memiliki sampel per jam untuk satu hari. Rentang
            7 dan 30 hari belum berisi data historis tambahan.
          </span>
        </div>
      </div>

      <div className="metric-grid analytics-metrics">
        <MetricCard
          title="Temperature mean"
          value={formatNumber(meanTemp)}
          suffix="°C"
          icon={Thermometer}
          tone="orange"
          change="Mean of available samples"
        />

        <MetricCard
          title="Humidity mean"
          value={formatNumber(meanHumidity)}
          suffix="%"
          icon={Droplets}
          tone="blue"
          change="Mean of available samples"
        />

        <MetricCard
          title="CO mean (simulated)"
          value={formatNumber(meanCO, 2)}
          suffix=""
          icon={AirVent}
          tone="purple"
          change="Not calibrated CO concentration"
        />

       
          <MetricCard
            title="Air Quality Index"
            value="N/A"
            suffix=""
            icon={Gauge}
            tone="green"
            change="Menunggu kalibrasi CO"
          />

      </div>

      <div className="lower-grid analytics-lower">
        {chartConfig.map((chart) => (
          <section className="panel chart-panel" key={chart.dataKey}>
            <div className="panel-header">
              <div>
                <h2>{chart.title}</h2>
                <p>{chart.subtitle}</p>
              </div>

              <span className="chart-note">FIRESTORE DATA</span>
            </div>

            <div className="small-chart">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartReadings}
                  margin={{ top: 10, right: 8, left: -18, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id={`fill-${chart.dataKey}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor={chart.fill}
                        stopOpacity={0.2}
                      />
                      <stop
                        offset="100%"
                        stopColor={chart.fill}
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>

                  <CartesianGrid
                    stroke="#e9efed"
                    strokeDasharray="4 5"
                    vertical={false}
                  />

                  <XAxis
                    dataKey="time"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "#87938f", fontSize: 10 }}
                  />

                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: "#87938f", fontSize: 10 }}
                  />

                  <Tooltip
                    formatter={(value) => [
                      `${value}${chart.suffix}`,
                      chart.title,
                    ]}
                  />

                  <Area
                    type="monotone"
                    dataKey={chart.dataKey}
                    name={chart.title}
                    stroke={chart.stroke}
                    fill={`url(#fill-${chart.dataKey})`}
                    strokeWidth={2.2}
                    connectNulls={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>
        ))}

        <section className="panel insight-panel">
          <div className="panel-header">
            <div>
              <h2>Interpretation notes</h2>
              <p>Before using real sensor data</p>
            </div>

            <ShieldCheck size={19} color="#168574" />
          </div>

          <ul className="insight-list">
            <li>
              Raw MQ-7 readings must not be presented as CO ppm without
              calibration.
            </li>
            <li>
              IAQI remains unavailable until its formula, breakpoints, units,
              and pollutant inputs are defined.
            </li>
            <li>
              Compare nodes only when timestamps and sensor handling are
              consistent.
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}

// --------------------------------------------------
// MONITORING NODES PAGE
// --------------------------------------------------

function Nodes({
  search,
  setSearch,
  filteredNodes,
  totalNodes,
}) {
  const onlineCount = filteredNodes.filter(
    (node) => node.status === "Online"
  ).length;

  return (
    <>
      <div className="section-toolbar">
        <div className="section-label">
          DEVICE INVENTORY <span className="tiny-dot" />
        </div>

        <div className="toolbar-right">
          <span className="node-total">
            {filteredNodes.length} of {totalNodes} Firestore nodes
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
          value={onlineCount}
          suffix=""
          icon={Wifi}
          tone="blue"
          change="Within search results"
        />

        <MetricCard
          title="Offline nodes"
          value={filteredNodes.length - onlineCount}
          suffix=""
          icon={Activity}
          tone="orange"
          change="Within search results"
        />
      </div>

      <section className="panel nodes-full-panel">
        <div className="panel-header nodes-header">
          <div>
            <h2>All monitoring nodes</h2>
            <p>Registry of sensor devices in the prototype network</p>
          </div>

          <button
            className="button button-primary"
            onClick={() =>
              window.alert(
                "Pendaftaran node belum tersedia karena backend belum terhubung."
              )
            }
          >
            + Add node
          </button>
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

          <button
            className="button button-secondary"
            onClick={() => setSearch("")}
          >
            Clear filters
          </button>
        </div>

        <NodeTable nodes={filteredNodes} />

        {filteredNodes.length === 0 && (
          <div className="empty-state">
            Tidak ada node yang cocok dengan pencarian.
          </div>
        )}

        <div className="table-foot">
          <span>
            Showing <strong>{filteredNodes.length}</strong> of {totalNodes}{" "}
            Firestore nodes
          </span>

          <span>
            Node registration is not connected to a backend yet.
          </span>
        </div>
      </section>

      <div className="info-callout">
        <ShieldCheck size={18} />

        <div>
          <strong>Prototype registry</strong>
          <span>
            Nama lokasi, status online/offline, dan waktu terakhir terlihat
            adalah data contoh. Status nyata nantinya ditentukan dari
            heartbeat atau timestamp pesan terakhir di backend.
          </span>
        </div>
      </div>
    </>
  );
}

// --------------------------------------------------
// REUSABLE COMPONENTS
// --------------------------------------------------

function RangeSelect({ range, setRange }) {
  return (
    <select
      value={range}
      onChange={(event) => setRange(event.target.value)}
      aria-label="Pilih rentang waktu"
    >
      {ranges.map((item) => (
        <option key={item} value={item}>
          {item}
        </option>
      ))}
    </select>
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

function NodeTable({ nodes, compact = false }) {
  return (
    <div className="table-scroll">
      <table className="node-table">
        <thead>
          <tr>
            <th>NODE / LOCATION</th>
            <th>STATUS</th>
            {!compact && <th>LAST SEEN</th>}
            <th>TEMPERATURE</th>
            <th>HUMIDITY</th>
            {!compact && <th>AREA</th>}
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
                    node.status === "Online"
                      ? "status-online"
                      : "status-offline"
                  }`}
                >
                  <i />
                  {node.status}
                </span>
              </td>

              {!compact && (
                <td className="last-seen">{node.lastSeen}</td>
              )}

              <td className="table-number">
                {node.temp == null ? "—" : `${node.temp.toFixed(1)} °C`}
              </td>

              <td className="table-number">
                {node.humidity == null ? "—" : `${node.humidity}%`}
              </td>

              {!compact && <td>{node.area}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;

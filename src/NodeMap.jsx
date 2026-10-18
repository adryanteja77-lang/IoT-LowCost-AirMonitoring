import React, { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const KEY = {
  Baik: "baik",
  Sedang: "sedang",
  "Tidak sehat": "tidak-sehat",
  "Sangat tidak sehat": "sangat",
  Berbahaya: "berbahaya",
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function iconFor(p) {
  if (p.planned) {
    return L.divIcon({
      className: "map-pin-wrap",
      html: '<div class="map-pin map-pin-planned">+</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }
  const key = p.category ? KEY[p.category] ?? "none" : "none";
  const cls = `map-pin cat-chip-${key}${p.online ? "" : " map-pin-off"}${p.test ? " map-pin-test" : ""}`;
  return L.divIcon({
    className: "map-pin-wrap",
    html: `<div class="${cls}">${p.iaqi ?? "–"}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function popupFor(p) {
  if (p.planned) {
    return `<strong>${esc(p.name)}</strong><br/>Rencana lokasi, belum terpasang.`;
  }
  const lines = [`<strong>${esc(p.name)}</strong>`, esc(p.area)];
  lines.push(p.iaqi != null ? `iAQI ${p.iaqi} · ${esc(p.category)}` : "iAQI: data belum cukup");
  lines.push(p.online ? "Online" : "Offline");
  if (p.test) lines.push("Berisi data uji");
  return lines.join("<br/>");
}

export default function NodeMap({ points }) {
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, { scrollWheelZoom: false }).setView([-8.6705, 115.17], 10);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 200);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    points.forEach((p) => {
      L.marker([p.lat, p.lng], { icon: iconFor(p) }).bindPopup(popupFor(p)).addTo(layer);
    });
    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 12 });
    } else if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 12);
    }
  }, [points]);

  return <div ref={boxRef} className="map-box" />;
}
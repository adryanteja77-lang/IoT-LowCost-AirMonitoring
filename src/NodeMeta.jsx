// Metadata lokasi node. EDIT file ini saat node dipasang di lokasi sebenarnya.
// Kunci = NODE_ID yang sama dengan di firmware (mis. "node-01").
// Koordinat: klik kanan lokasi di Google Maps, lalu salin angka lat, lng.
export const NODE_META = {
  "node-01": {
    name: "Node 1 (prototipe)",
    area: "Denpasar", // GANTI sesuai lokasi pemasangan
    lat: -8.6705, // GANTI (sementara pusat Denpasar)
    lng: 115.2126, // GANTI
  },
   "node-02": {
    name: "Node 2 (prototipe)",
    area: "Rumah",
    lat: -8.6708,           // geser sedikit supaya pin tidak menumpuk
    lng: 115.2129,
  },
};

// Rencana titik pemasangan di kawasan wisata. Belum terpasang, jadi ditampilkan
// di peta sebagai "rencana" (bukan data terukur). Koordinat perkiraan pusat kawasan.
export const PLANNED_SITES = [
  { id: "plan-kuta", name: "Kuta (rencana)", area: "Kuta", lat: -8.7184, lng: 115.1686 },
  { id: "plan-seminyak", name: "Seminyak (rencana)", area: "Seminyak", lat: -8.6913, lng: 115.1683 },
  { id: "plan-canggu", name: "Canggu (rencana)", area: "Canggu", lat: -8.6478, lng: 115.1385 },
];
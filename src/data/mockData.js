
/**
 * Bali AirWatch
 * DATA SIMULASI UNTUK PENGEMBANGAN UI.
 * Bukan hasil pengukuran sensor nyata.
 */

export const mockReadings = [
  { time: "08.00", co: 2.1, temp: 28.1, humidity: 76 },
  { time: "09.00", co: 2.4, temp: 28.8, humidity: 74 },
  { time: "10.00", co: 2.8, temp: 29.4, humidity: 72 },
  { time: "11.00", co: 3.2, temp: 30.1, humidity: 69 },
  { time: "12.00", co: 3.0, temp: 30.6, humidity: 67 },
  { time: "13.00", co: 2.7, temp: 30.2, humidity: 68 },
  { time: "14.00", co: 2.5, temp: 29.8, humidity: 70 },
  { time: "15.00", co: 2.2, temp: 29.3, humidity: 72 },
];

export const mockNodes = [
  {
    id: "BALI-001",
    name: "Kawasan Pantai Kuta",
    area: "Badung",
    status: "Online",
    lastSeen: "Baru saja",
    co: 2.5,
    temp: 29.8,
    humidity: 70,
  },
  {
    id: "BALI-002",
    name: "Area Sanur",
    area: "Denpasar",
    status: "Online",
    lastSeen: "1 menit lalu",
    co: 2.7,
    temp: 30.1,
    humidity: 68,
  },
  {
    id: "BALI-003",
    name: "Kawasan Ubud",
    area: "Gianyar",
    status: "Offline",
    lastSeen: "18 menit lalu",
    co: null,
    temp: null,
    humidity: null,
  },
];

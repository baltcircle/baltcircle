// Map coordinate system: 0..1000 x, 0..700 y for the stylized
// Baltic coast map SVG. lat=y, lng=x for storage simplicity.
//
// NOTE: This is MVP / demo geometry only. The coastline, town positions,
// cycling routes and zones are hand-drawn approximations for the prototype
// and are NOT derived from official GIS / OSM data.

export const MAP_W = 1000;
export const MAP_H = 700;

export interface Tariff {
  id: "payg" | "day" | "month";
  name: string;
  price: number;
  unit: string;
  unlock?: number;
  perMinute?: number;
  freeMinutes?: number;
  description: string;
  popular?: boolean;
}

export const TARIFFS: Tariff[] = [
  {
    id: "payg",
    name: "По минутам",
    price: 50,
    unit: "₽ + 6 ₽/мин",
    unlock: 50,
    perMinute: 6,
    description: "Платите только за время поездки. Без подписки, без обязательств.",
  },
  {
    id: "day",
    name: "Дневной",
    price: 390,
    unit: "₽ / 24 часа",
    freeMinutes: 60,
    description: "60 бесплатных минут каждые 2 часа в течение суток.",
    popular: true,
  },
  {
    id: "month",
    name: "Месячный",
    price: 1490,
    unit: "₽ / 30 дней",
    freeMinutes: 45,
    description: "45 бесплатных минут на каждую поездку.",
  },
];

// Coastal launch towns (west → east along the Baltic shore).
// Each town anchors a cluster of parking stations.
export const TOWNS = [
  { id: "svetlogorsk", name: "Светлогорск", x: 215, y: 350 },
  { id: "pionersky",   name: "Пионерский",  x: 500, y: 305 },
  { id: "zelenogradsk", name: "Зеленоградск", x: 800, y: 360 },
] as const;

// Parkings — clustered around the three coastal towns (5 each = 15 total),
// kept inside the operating zone.
export const PARKINGS = [
  // --- Светлогорск (west) ---
  { id: "P-01", name: "Светлогорск · Променад",      x: 195, y: 300, capacity: 16 },
  { id: "P-02", name: "Светлогорск · Вокзал",        x: 250, y: 410, capacity: 12 },
  { id: "P-03", name: "Светлогорск · Тихая",         x: 160, y: 380, capacity: 10 },
  { id: "P-04", name: "Светлогорск · Лиственничная", x: 300, y: 360, capacity: 10 },
  { id: "P-05", name: "Светлогорск · Янтарь-холл",   x: 230, y: 250, capacity: 14 },
  // --- Пионерский (middle) ---
  { id: "P-06", name: "Пионерский · Порт",           x: 470, y: 250, capacity: 16 },
  { id: "P-07", name: "Пионерский · Набережная",     x: 520, y: 300, capacity: 14 },
  { id: "P-08", name: "Пионерский · Центр",          x: 540, y: 360, capacity: 12 },
  { id: "P-09", name: "Пионерский · Сосновый бор",   x: 430, y: 340, capacity: 10 },
  { id: "P-10", name: "Пионерский · Школьная",       x: 500, y: 410, capacity: 8 },
  // --- Зеленоградск (east) ---
  { id: "P-11", name: "Зеленоградск · Курортный",    x: 790, y: 300, capacity: 18 },
  { id: "P-12", name: "Зеленоградск · Вокзал",       x: 840, y: 420, capacity: 14 },
  { id: "P-13", name: "Зеленоградск · Бульвар",      x: 750, y: 360, capacity: 12 },
  { id: "P-14", name: "Зеленоградск · Маяк",         x: 860, y: 300, capacity: 12 },
  { id: "P-15", name: "Зеленоградск · Куршская коса", x: 905, y: 360, capacity: 10 },
];

// Cycling routes (велодорожки) connecting the towns along the coast.
// MVP/demo polylines — distanceKm is an approximate signposted value.
export interface Route {
  id: string;
  name: string;
  distanceKm: number;
  points: [number, number][];
}

export const ROUTES: Route[] = [
  {
    id: "R-01",
    name: "Светлогорск → Пионерский",
    distanceKm: 6,
    points: [[215, 350], [300, 320], [380, 290], [440, 270], [500, 305]],
  },
  {
    id: "R-02",
    name: "Пионерский → Зеленоградск",
    distanceKm: 12,
    points: [[500, 305], [580, 300], [660, 320], [730, 345], [800, 360]],
  },
  {
    id: "R-03",
    name: "Приморское велокольцо",
    distanceKm: 9,
    points: [[800, 360], [840, 430], [760, 470], [620, 470], [500, 450], [380, 440], [260, 430], [215, 350]],
  },
];

// Operating zone (coastal strip covering all three towns)
export const OPERATING_ZONE = [
  [110, 200], [260, 180], [470, 200], [620, 200], [780, 230],
  [930, 260], [950, 380], [900, 500], [760, 540], [560, 520],
  [380, 510], [220, 480], [120, 400], [90, 300],
];

// Slow / restricted zones (15 km/h — promenades and central streets)
export const SLOW_ZONES = [
  {
    id: "S-01", name: "Светлогорск · Променад",
    polygon: [[150, 270], [270, 270], [270, 330], [150, 330]],
  },
  {
    id: "S-02", name: "Пионерский · Набережная",
    polygon: [[470, 270], [560, 270], [560, 330], [470, 330]],
  },
  {
    id: "S-03", name: "Зеленоградск · Курортный пр.",
    polygon: [[750, 280], [880, 280], [880, 340], [750, 340]],
  },
];

// Forbidden zones (no riding, no parking)
export const FORBIDDEN_ZONES = [
  {
    id: "F-01", name: "Пляжная зона (заезд запрещён)",
    polygon: [[330, 200], [430, 205], [430, 245], [330, 240]],
  },
  {
    id: "F-02", name: "Порт Пионерский",
    polygon: [[430, 210], [490, 210], [490, 250], [430, 250]],
  },
  {
    id: "F-03", name: "Куршская коса (нац. парк)",
    polygon: [[915, 320], [965, 320], [965, 410], [915, 410]],
  },
];

// --- Real-world geo anchoring -------------------------------------------
// The stylized map above uses an abstract 1000x700 SVG space. To render the
// same overlays on a real Yandex map we anchor that space to the three launch
// towns' true coordinates and derive an affine transform (exact at the three
// anchors). Coefficients were solved from the TOWN svg positions above mapped
// to these real [lng, lat] pairs:
//   Светлогорск  -> 20.1547, 54.9430
//   Пионерский   -> 20.2330, 54.9520
//   Зеленоградск -> 20.4750, 54.9600
// lng = LNG.a*x + LNG.b*y + LNG.c ; lat = LAT.a*x + LAT.b*y + LAT.c
const LNG = { a: 5.2087403599e-4, b: 1.5588688946e-3, c: 19.497107969 };
const LAT = { a: 2.9305912596e-5, b: -1.4395886889e-5, c: 54.941737789 };

/** Convert a stylized map point (x = lng-field, y = lat-field) into a real
 *  [lat, lng] pair for Yandex Maps (which expects [lat, lng] order). */
export function svgToLatLng(x: number, y: number): [number, number] {
  return [LAT.a * x + LAT.b * y + LAT.c, LNG.a * x + LNG.b * y + LNG.c];
}

// Real center of the coastal launch area (≈ Пионерский, between the towns).
export const REAL_CENTER: [number, number] = svgToLatLng(500, 330);

export function pointInPolygon(p: [number, number], poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = ((yi > p[1]) !== (yj > p[1])) &&
      (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function checkZoneState(x: number, y: number) {
  const p: [number, number] = [x, y];
  for (const z of FORBIDDEN_ZONES) if (pointInPolygon(p, z.polygon)) return { kind: "forbidden", name: z.name };
  for (const z of SLOW_ZONES)     if (pointInPolygon(p, z.polygon)) return { kind: "slow", name: z.name };
  if (!pointInPolygon(p, OPERATING_ZONE)) return { kind: "out", name: "Вне зоны обслуживания" };
  return { kind: "ok", name: "В зоне обслуживания" };
}

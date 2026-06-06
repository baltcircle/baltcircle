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

// --- Real-world geo (Yandex map) ----------------------------------------
// Real city-centre coordinates [lat, lng] for the three launch towns
// (Самбийский полуостров, Калининградская область). Used directly by the
// Yandex map so towns/parkings/routes/zones render in their true positions
// instead of being squeezed through an abstract affine transform.
export const REAL_TOWNS = {
  svetlogorsk: [54.9442, 20.1561],
  pionersky: [54.9429, 20.2216],
  zelenogradsk: [54.9440, 20.4644],
} as const;

/** Real [lat, lng] anchor for a town id. */
export function townLatLng(id: keyof typeof REAL_TOWNS): readonly [number, number] {
  return REAL_TOWNS[id];
}

// Real center of the coastal launch area (midpoint of the three towns).
export const REAL_CENTER: [number, number] = [54.945, 20.275];

// --- Realistic coastal GPS routes ---------------------------------------
// Hand-encoded approximate [lat, lng] paths tracing the Baltic shore cycling
// corridor between the three launch towns. These are manual approximations of
// the coastal road/велодорожка alignment (NOT copied from any proprietary map
// dataset) so the Yandex base map shows believable on-road geometry rather
// than the abstract affine-transformed SVG polylines. Distance/time are
// approximate signposted values.
export interface CoastRoute {
  id: string;
  name: string;
  distanceKm: number;
  minutes: number;        // approx. easy-pace cycling time
  color: string;
  path: [number, number][]; // [lat, lng]
}

export const COAST_ROUTES: CoastRoute[] = [
  {
    id: "C-01",
    name: "Светлогорск → Пионерский",
    distanceKm: 6,
    minutes: 22,
    color: "#1f9e93",
    path: [
      [54.9442, 20.1561], // Светлогорск
      [54.9446, 20.1700],
      [54.9448, 20.1850],
      [54.9446, 20.2000],
      [54.9438, 20.2130],
      [54.9429, 20.2216], // Пионерский
    ],
  },
  {
    id: "C-02",
    name: "Пионерский → Зеленоградск",
    distanceKm: 12,
    minutes: 42,
    color: "#1d6f8e",
    path: [
      [54.9429, 20.2216], // Пионерский
      [54.9436, 20.2500],
      [54.9444, 20.2850],
      [54.9448, 20.3250],
      [54.9450, 20.3700],
      [54.9448, 20.4150],
      [54.9444, 20.4450],
      [54.9440, 20.4644], // Зеленоградск
    ],
  },
  {
    id: "C-03",
    name: "Приморское велокольцо",
    distanceKm: 26,
    minutes: 95,
    color: "#26a884",
    path: [
      [54.9442, 20.1561], // Светлогорск
      [54.9429, 20.2216], // Пионерский
      [54.9440, 20.4644], // Зеленоградск
      [54.9360, 20.4500], // south leg back west
      [54.9300, 20.3900],
      [54.9290, 20.3200],
      [54.9310, 20.2500],
      [54.9360, 20.1900],
      [54.9442, 20.1561], // close loop at Светлогорск
    ],
  },
];

// Ordered real waypoints for Yandex route construction (multiRouter):
// Светлогорск ↔ Пионерский ↔ Зеленоградск.
export const ROUTE_WAYPOINTS: [number, number][] = [
  [...REAL_TOWNS.svetlogorsk],
  [...REAL_TOWNS.pionersky],
  [...REAL_TOWNS.zelenogradsk],
];

// --- Real-coordinate zones (Yandex map) ---------------------------------
// Clean [lat, lng] polygons covering the real coastal corridor. These render
// directly on the Yandex base map (no affine distortion). The abstract-space
// OPERATING_ZONE/SLOW_ZONES/FORBIDDEN_ZONES above remain for the stylized
// CoastMap fallback and for checkZoneState (which runs in abstract space).
export interface RealZone {
  id: string;
  name: string;
  kind: "operating" | "slow" | "forbidden";
  polygon: [number, number][]; // [lat, lng]
}

export const REAL_ZONES: RealZone[] = [
  {
    id: "Z-OP",
    name: "Зона обслуживания побережья",
    kind: "operating",
    polygon: [
      [54.9560, 20.1400],
      [54.9540, 20.2300],
      [54.9520, 20.3400],
      [54.9510, 20.4750],
      [54.9360, 20.4850],
      [54.9280, 20.3600],
      [54.9300, 20.2300],
      [54.9360, 20.1450],
    ],
  },
  {
    id: "S-01",
    name: "Светлогорск · Променад",
    kind: "slow",
    polygon: [
      [54.9470, 20.1490],
      [54.9470, 20.1640],
      [54.9420, 20.1640],
      [54.9420, 20.1490],
    ],
  },
  {
    id: "S-02",
    name: "Пионерский · Набережная",
    kind: "slow",
    polygon: [
      [54.9455, 20.2120],
      [54.9455, 20.2300],
      [54.9405, 20.2300],
      [54.9405, 20.2120],
    ],
  },
  {
    id: "S-03",
    name: "Зеленоградск · Курортный пр.",
    kind: "slow",
    polygon: [
      [54.9470, 20.4540],
      [54.9470, 20.4740],
      [54.9415, 20.4740],
      [54.9415, 20.4540],
    ],
  },
  {
    id: "F-01",
    name: "Пляжная зона (заезд запрещён)",
    kind: "forbidden",
    polygon: [
      [54.9495, 20.1520],
      [54.9495, 20.1660],
      [54.9475, 20.1660],
      [54.9475, 20.1520],
    ],
  },
  {
    id: "F-02",
    name: "Порт Пионерский",
    kind: "forbidden",
    polygon: [
      [54.9475, 20.2150],
      [54.9475, 20.2280],
      [54.9455, 20.2280],
      [54.9455, 20.2150],
    ],
  },
  {
    id: "F-03",
    name: "Куршская коса (нац. парк)",
    kind: "forbidden",
    polygon: [
      [54.9500, 20.4780],
      [54.9500, 20.4950],
      [54.9400, 20.4950],
      [54.9400, 20.4780],
    ],
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

// --- Abstract → real mapping for stored bike/parking points -------------
// The backend still stores positions in the stylized 1000x700 space (lat=y,
// lng=x). Rather than shear that whole space onto the globe with a single
// affine (which made everything look crooked), we anchor each stored point to
// the *nearest* town centre and apply only its small local offset, scaled to
// metres. This keeps clusters tight and upright around the correct town.
// Per-town clusters span only tens of svg-units, so a gentle metres-per-unit
// factor keeps each town's stations within a few hundred metres of centre.
const SVG_TOWNS: { id: keyof typeof REAL_TOWNS; x: number; y: number }[] = [
  { id: "svetlogorsk", x: 215, y: 350 },
  { id: "pionersky", x: 500, y: 305 },
  { id: "zelenogradsk", x: 800, y: 360 },
];

const METERS_PER_UNIT = 9; // ~9 m per stylized unit for local cluster spread
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((54.944 * Math.PI) / 180);

/** Map a stored abstract point (x = lng-field, y = lat-field) to a real
 *  [lat, lng] near its nearest launch town. Used for bikes & parkings so the
 *  backend's x/y storage stays unchanged but markers land in the right place. */
export function mapToReal(x: number, y: number): [number, number] {
  let best = SVG_TOWNS[0];
  let bestD = Infinity;
  for (const t of SVG_TOWNS) {
    const d = (t.x - x) ** 2 + (t.y - y) ** 2;
    if (d < bestD) { bestD = d; best = t; }
  }
  const [baseLat, baseLng] = REAL_TOWNS[best.id];
  const eastM = (x - best.x) * METERS_PER_UNIT;   // +x = east
  const northM = (best.y - y) * METERS_PER_UNIT;  // +y = south, so invert
  return [
    baseLat + northM / M_PER_DEG_LAT,
    baseLng + eastM / M_PER_DEG_LNG,
  ];
}

// Linear span of the stylized SVG viewBox over real coordinates, centred on
// REAL_CENTER. Used by the SVG fallback map (no Yandex key) so operators can
// still click to add route/zone points and saved objects can be rendered back.
const SVG_LAT_SPAN = 0.18; // degrees latitude top-to-bottom of the SVG
const SVG_LNG_SPAN = 0.36; // degrees longitude left-to-right of the SVG

/** SVG pixel (x in 0..MAP_W, y in 0..MAP_H) -> real [lat, lng]. */
export function svgToLatLng(x: number, y: number): [number, number] {
  const lng = REAL_CENTER[1] + (x / MAP_W - 0.5) * SVG_LNG_SPAN;
  const lat = REAL_CENTER[0] - (y / MAP_H - 0.5) * SVG_LAT_SPAN; // +y = south
  return [lat, lng];
}

/** Real [lat, lng] -> SVG pixel [x, y] (inverse of svgToLatLng). */
export function latLngToSvg(lat: number, lng: number): [number, number] {
  const x = ((lng - REAL_CENTER[1]) / SVG_LNG_SPAN + 0.5) * MAP_W;
  const y = (0.5 - (lat - REAL_CENTER[0]) / SVG_LAT_SPAN) * MAP_H;
  return [x, y];
}

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

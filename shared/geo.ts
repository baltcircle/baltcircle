// Map coordinate system: 0..1000 x, 0..700 y for the stylized
// Kaliningrad map SVG. lat=y, lng=x for storage simplicity.

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

// Parkings — designed to be inside operating zone
export const PARKINGS = [
  { id: "P-01", name: "Площадь Победы",         x: 520, y: 320, capacity: 14 },
  { id: "P-02", name: "Кафедральный собор",     x: 470, y: 410, capacity: 18 },
  { id: "P-03", name: "Музей янтаря",           x: 720, y: 280, capacity: 12 },
  { id: "P-04", name: "Южный вокзал",           x: 480, y: 540, capacity: 16 },
  { id: "P-05", name: "Северный вокзал",        x: 510, y: 240, capacity: 10 },
  { id: "P-06", name: "Парк Юность",            x: 660, y: 220, capacity: 12 },
  { id: "P-07", name: "Остров Канта",           x: 460, y: 430, capacity: 14 },
  { id: "P-08", name: "ТРЦ Европа",             x: 540, y: 360, capacity: 16 },
  { id: "P-09", name: "Куйбышева",              x: 380, y: 360, capacity: 10 },
  { id: "P-10", name: "Сортировочная",          x: 340, y: 290, capacity: 8 },
  { id: "P-11", name: "Балтрайон",              x: 300, y: 470, capacity: 8 },
  { id: "P-12", name: "Сельма",                 x: 660, y: 160, capacity: 8 },
  { id: "P-13", name: "БФУ им. Канта",          x: 580, y: 300, capacity: 12 },
  { id: "P-14", name: "Стадион Калининград",    x: 820, y: 380, capacity: 18 },
  { id: "P-15", name: "Набережная Преголи",     x: 420, y: 460, capacity: 10 },
];

// Operating zone (big rounded polygon — entire serviced city)
export const OPERATING_ZONE = [
  [180, 180], [320, 130], [520, 110], [720, 130], [860, 200],
  [900, 320], [890, 450], [820, 560], [680, 620], [500, 640],
  [340, 620], [220, 550], [150, 420], [140, 280],
];

// Slow / restricted zones (15 km/h, e.g. parks, narrow streets)
export const SLOW_ZONES = [
  {
    id: "S-01", name: "Остров Канта (15 км/ч)",
    polygon: [[420, 400], [510, 400], [510, 460], [420, 460]],
  },
  {
    id: "S-02", name: "Центральная площадь",
    polygon: [[495, 300], [560, 295], [560, 350], [495, 350]],
  },
  {
    id: "S-03", name: "Парк Юность",
    polygon: [[620, 190], [710, 190], [710, 250], [620, 250]],
  },
];

// Forbidden zones (no riding, no parking)
export const FORBIDDEN_ZONES = [
  {
    id: "F-01", name: "Аэропорт Храброво (заезд запрещён)",
    polygon: [[60, 360], [140, 340], [150, 420], [70, 430]],
  },
  {
    id: "F-02", name: "Военная часть",
    polygon: [[800, 540], [880, 530], [890, 590], [810, 600]],
  },
  {
    id: "F-03", name: "Промзона",
    polygon: [[260, 590], [360, 590], [360, 650], [260, 650]],
  },
];

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

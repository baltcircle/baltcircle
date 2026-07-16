import { MARKER_COLORS } from "./mapStyle";

export function bikeMarkerColor(status: string): string {
  switch (status) {
    case "available":   return MARKER_COLORS.bikeAvailable;
    case "rented":      return MARKER_COLORS.bikeRented;
    case "maintenance": return MARKER_COLORS.bikeMaintenance;
    case "reserved":    return MARKER_COLORS.bikeReserved;
    default:            return MARKER_COLORS.bikeDefault;
  }
}

export function ticketMarkerColor(priority: string): string {
  return priority === "critical" || priority === "high"
    ? MARKER_COLORS.ticketHigh
    : MARKER_COLORS.ticketLow;
}

/** Build a small circular DOM marker element (bikes/rides/tickets). */
export function dotMarkerEl(color: string, opts: { ring?: boolean; size?: number; clickable?: boolean } = {}): HTMLDivElement {
  const size = opts.size ?? 16;
  const el = document.createElement("div");
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.borderRadius = "50%";
  el.style.background = color;
  el.style.border = opts.ring ? "3px solid #fff" : "2px solid #fff";
  el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.35)";
  el.style.boxSizing = "border-box";
  el.style.cursor = opts.clickable ? "pointer" : "default";
  return el;
}

/** Build a "P" parking marker element. */
export function parkingMarkerEl(inactive: boolean, clickable: boolean): HTMLDivElement {
  const el = document.createElement("div");
  el.style.minWidth = "22px";
  el.style.height = "22px";
  el.style.padding = "0 4px";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.borderRadius = "6px";
  el.style.background = inactive ? MARKER_COLORS.parkingInactive : MARKER_COLORS.parkingActive;
  el.style.color = "#fff";
  el.style.font = "600 12px/1 system-ui, sans-serif";
  el.style.border = "2px solid #fff";
  el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.35)";
  el.style.opacity = inactive ? "0.75" : "1";
  el.style.cursor = clickable ? "pointer" : "default";
  el.textContent = "P";
  el.title = inactive ? "Парковка · неактивна" : "Парковка";
  return el;
}

/** Fill colour for a saved zone polygon, derived from its stroke colour. */
export function fillFromColor(color: string): string {
  return `${color}22`; // ~13% alpha
}

// map_objects.points может прийти как array (после hydrate на сервере)
// или как JSON-строка (легаси-кэш / старые версии). Страхуемся.
export function coercePoints(raw: unknown): [number, number][] {
  if (Array.isArray(raw)) return raw as [number, number][];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed as [number, number][] : [];
    } catch { return []; }
  }
  return [];
}

// Мягкое скругление углов квадратичной кривой Безье через вершину:
// — берём точку в (1-r) сегмента до вершины (p1) и в r после (p2);
// — вершина (b) не включается, но служит контрольной точкой Bézier;
// — генерируем segments промежуточных точек вдоль B(t) = (1-t)²p1 + 2(1-t)t·b + t²p2;
// — касательные кривой в концах совпадают с направлением входящего/выходящего
//   сегмента — G1-непрерывность без изломов. Кривая не выходит за выпуклую оболочку
//   {p1, b, p2}, то есть выбросы невозможны.
// radius — доля сегмента (0..0.5); segments — число на один угол.
export function smoothCorners(coords: number[][], radius = 0.25, segments = 12): number[][] {
  if (coords.length < 3) return coords;
  const r = Math.min(0.49, Math.max(0, radius));
  const out: number[][] = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i - 1];
    const [bx, by] = coords[i];
    const [cx, cy] = coords[i + 1];
    const p1x = ax + (bx - ax) * (1 - r);
    const p1y = ay + (by - ay) * (1 - r);
    const p2x = bx + (cx - bx) * r;
    const p2y = by + (cy - by) * r;
    // Семплируем квадратичную Bézier: t в (0, 1). t=0 текущее out[-1]
    // (это p1 для i>1, а для i=1 — push первой вершины выше + мы добавим p1 следом),
    // чтобы избежать дублирования p1. t=1 — p2 (включаем).
    if (out[out.length - 1][0] !== p1x || out[out.length - 1][1] !== p1y) {
      out.push([p1x, p1y]);
    }
    for (let s = 1; s <= segments; s++) {
      const t = s / (segments + 1);
      const u = 1 - t;
      out.push([
        u * u * p1x + 2 * u * t * bx + t * t * p2x,
        u * u * p1y + 2 * u * t * by + t * t * p2y,
      ]);
    }
    out.push([p2x, p2y]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

// (Легаси) Centripetal Catmull-Rom — оставлено на будущее, не используется.
export function catmullRomSmooth(coords: number[][], segments = 8, alpha = 0.5): number[][] {
  if (coords.length < 3) return coords;

  // 1) Убираем дубликаты (совпавшие соседние точки) — иначе в знаменателях будет
  //    деление на ~0, и сплайн выстрелит в бесконечность.
  const EPS = 1e-9;
  const clean: number[][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [px, py] = clean[clean.length - 1];
    const [cx, cy] = coords[i];
    if (Math.hypot(cx - px, cy - py) > EPS) clean.push(coords[i]);
  }
  if (clean.length < 3) return clean;

  // 2) Фантомные точки — зеркальное отражение, чтобы кривая на концах
  //    шла вдоль сегмента, а не куда-то в сторону.
  const first = clean[0];
  const second = clean[1];
  const preLast = clean[clean.length - 2];
  const last = clean[clean.length - 1];
  const phantomStart = [2 * first[0] - second[0], 2 * first[1] - second[1]];
  const phantomEnd = [2 * last[0] - preLast[0], 2 * last[1] - preLast[1]];
  const pts = [phantomStart, ...clean, phantomEnd];

  const out: number[][] = [];
  const tj = (ti: number, xi: number[], xj: number[]) => {
    const dx = xj[0] - xi[0], dy = xj[1] - xi[1];
    return ti + Math.pow(Math.hypot(dx, dy), alpha);
  };

  for (let i = 0; i < pts.length - 3; i++) {
    const p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3];
    const t0 = 0;
    const t1 = tj(t0, p0, p1);
    const t2 = tj(t1, p1, p2);
    const t3 = tj(t2, p2, p3);

    // 3) Гард от вырожденных параметров — если сегмент слипся, просто
    //    ставим конечные точки без интерполяции.
    if (t1 === t0 || t2 === t1 || t3 === t2) {
      out.push(p1);
      continue;
    }

    for (let s = 0; s < segments; s++) {
      const t = t1 + (s / segments) * (t2 - t1);
      const a1x = ((t1 - t) * p0[0] + (t - t0) * p1[0]) / (t1 - t0);
      const a1y = ((t1 - t) * p0[1] + (t - t0) * p1[1]) / (t1 - t0);
      const a2x = ((t2 - t) * p1[0] + (t - t1) * p2[0]) / (t2 - t1);
      const a2y = ((t2 - t) * p1[1] + (t - t1) * p2[1]) / (t2 - t1);
      const a3x = ((t3 - t) * p2[0] + (t - t2) * p3[0]) / (t3 - t2);
      const a3y = ((t3 - t) * p2[1] + (t - t2) * p3[1]) / (t3 - t2);
      const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
      const b1y = ((t2 - t) * a1y + (t - t0) * a2y) / (t2 - t0);
      const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
      const b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);
      const cx = ((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1);
      const cy = ((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1);

      // 4) Страховка: если всё-таки вылетело в NaN/Infinity — берём линейную
      //    интерполяцию между p1 и p2. Сглаживания нет, но линия не улетает.
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        const lin = s / segments;
        out.push([p1[0] + (p2[0] - p1[0]) * lin, p1[1] + (p2[1] - p1[1]) * lin]);
      } else {
        out.push([cx, cy]);
      }
    }
  }
  out.push(clean[clean.length - 1]);
  return out;
}

import { describe, it, expect } from "vitest";
import {
  createGeoFilter,
  haversineM,
  bearingDeg,
  douglasPeucker,
  segmentTrack,
  TRACK_GAP_MS,
  type RawFix,
  type TrackFix,
} from "./geoSmoothing";

// Базовая точка — Пионерский. Небольшие шаги в градусах: ~1e-5° ≈ 1.1 м широты.
const BASE = { lat: 54.9429, lng: 20.2216 };

function fix(over: Partial<RawFix> & { t: number }): RawFix {
  return {
    lat: over.lat ?? BASE.lat,
    lng: over.lng ?? BASE.lng,
    accuracy: over.accuracy ?? 10,
    heading: over.heading ?? null,
    timestamp: over.t,
  };
}

describe("haversineM", () => {
  it("нулевое расстояние для совпадающих точек", () => {
    expect(haversineM(BASE.lat, BASE.lng, BASE.lat, BASE.lng)).toBe(0);
  });

  it("~111 м на 0.001° широты", () => {
    const d = haversineM(BASE.lat, BASE.lng, BASE.lat + 0.001, BASE.lng);
    expect(d).toBeGreaterThan(108);
    expect(d).toBeLessThan(114);
  });
});

describe("bearingDeg", () => {
  it("север ≈ 0°", () => {
    expect(bearingDeg(BASE.lat, BASE.lng, BASE.lat + 0.001, BASE.lng)).toBeCloseTo(0, 0);
  });
  it("восток ≈ 90°", () => {
    expect(bearingDeg(BASE.lat, BASE.lng, BASE.lat, BASE.lng + 0.001)).toBeCloseTo(90, 0);
  });
  it("возвращает диапазон 0..360", () => {
    const b = bearingDeg(BASE.lat, BASE.lng, BASE.lat - 0.001, BASE.lng - 0.001);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});

describe("createGeoFilter — приёмка/отбрасывание", () => {
  it("первая точка принимается всегда, даже с плохой точностью", () => {
    const f = createGeoFilter();
    const out = f.push(fix({ t: 0, accuracy: 500 }));
    expect(out).not.toBeNull();
    expect(out!.lat).toBe(BASE.lat);
  });

  it("отбрасывает точку с accuracy хуже порога", () => {
    const f = createGeoFilter({ maxAccuracyM: 50 });
    f.push(fix({ t: 0, accuracy: 10 }));
    const bad = f.push(fix({ t: 3000, lat: BASE.lat + 0.0001, accuracy: 200 }));
    expect(bad).toBeNull();
  });

  it("отбрасывает телепорт (скорость > 60 км/ч)", () => {
    const f = createGeoFilter();
    f.push(fix({ t: 0 }));
    // +0.01° широты ≈ 1.1 км за 1 сек = ~4000 км/ч — заведомо телепорт.
    const jump = f.push(fix({ t: 1000, lat: BASE.lat + 0.01 }));
    expect(jump).toBeNull();
  });

  it("принимает правдоподобное перемещение велосипедиста", () => {
    const f = createGeoFilter();
    f.push(fix({ t: 0 }));
    // ~11 м за 3 сек ≈ 3.7 м/с (13 км/ч) — норм.
    const ok = f.push(fix({ t: 3000, lat: BASE.lat + 0.0001 }));
    expect(ok).not.toBeNull();
  });
});

describe("createGeoFilter — восстановление после серии выбросов", () => {
  it("после N телепортов подряд принимает точку принудительно", () => {
    const f = createGeoFilter({ maxConsecutiveRejects: 3 });
    f.push(fix({ t: 0 }));
    const far = { lat: BASE.lat + 0.05, lng: BASE.lng + 0.05 };
    expect(f.push(fix({ t: 1000, ...far }))).toBeNull();
    expect(f.push(fix({ t: 2000, ...far }))).toBeNull();
    // третий подряд — пробивает затор, фильтр перескакивает на новое место.
    const forced = f.push(fix({ t: 3000, ...far }));
    expect(forced).not.toBeNull();
    expect(forced!.lat).toBeCloseTo(far.lat, 5);
  });
});

describe("createGeoFilter — сглаживание (EMA)", () => {
  it("гасит мелкий джиттер: результат ближе к старой позиции, чем сырой шум", () => {
    const f = createGeoFilter({ baseAlpha: 0.3 });
    f.push(fix({ t: 0, accuracy: 20 }));
    // Дрожание ~2 м при точности 20 м → snr мал → сильное сглаживание.
    const jitterLat = BASE.lat + 0.00002;
    const out = f.push(fix({ t: 3000, lat: jitterLat, accuracy: 20 }));
    expect(out).not.toBeNull();
    // Сглаженная широта должна быть между старой и сырой, ближе к старой.
    const moved = (out!.lat - BASE.lat) / (jitterLat - BASE.lat);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(0.6);
  });

  it("реальное крупное перемещение проходит почти без задержки (alpha→1)", () => {
    const f = createGeoFilter({ baseAlpha: 0.3 });
    f.push(fix({ t: 0, accuracy: 10 }));
    // 22 м при точности 10 м → snr≈2 → alpha=1 (snap).
    const target = BASE.lat + 0.0002;
    const out = f.push(fix({ t: 4000, lat: target, accuracy: 10 }));
    expect(out).not.toBeNull();
    expect(out!.lat).toBeCloseTo(target, 6);
  });

  it("reset() очищает историю — следующая точка снова первая", () => {
    const f = createGeoFilter();
    f.push(fix({ t: 0 }));
    f.reset();
    const out = f.push(fix({ t: 1000, lat: BASE.lat + 0.02, accuracy: 300 }));
    expect(out).not.toBeNull(); // как первая — принимается несмотря на телепорт+плохую точность
  });

  it("использует GPS-heading, когда он есть", () => {
    const f = createGeoFilter();
    f.push(fix({ t: 0 }));
    const out = f.push(fix({ t: 3000, lat: BASE.lat + 0.0001, heading: 123 }));
    expect(out!.heading).toBe(123);
  });

  it("считает heading по вектору движения, когда GPS-heading нет", () => {
    const f = createGeoFilter();
    f.push(fix({ t: 0 }));
    // движение строго на восток → курс ≈ 90°.
    const out = f.push(fix({ t: 3000, lng: BASE.lng + 0.0002, heading: null }));
    expect(out!.heading).not.toBeNull();
    expect(out!.heading!).toBeGreaterThan(80);
    expect(out!.heading!).toBeLessThan(100);
  });
});

describe("douglasPeucker", () => {
  it("оставляет концы для линии из 2 точек", () => {
    const line: [number, number][] = [[0, 0], [1, 1]];
    expect(douglasPeucker(line, 0.1)).toEqual(line);
  });

  it("выкидывает почти коллинеарные промежуточные точки", () => {
    const line: [number, number][] = [[0, 0], [1, 0.001], [2, 0], [3, 0.001], [4, 0]];
    const out = douglasPeucker(line, 0.01);
    expect(out).toEqual([[0, 0], [4, 0]]);
  });

  it("сохраняет точку реального поворота", () => {
    const line: [number, number][] = [[0, 0], [1, 0], [2, 2], [3, 2]];
    const out = douglasPeucker(line, 0.5);
    // поворот в [2,2] должен уцелеть
    expect(out).toContainEqual([2, 2]);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([3, 2]);
  });

  it("не увеличивает число точек", () => {
    const line: [number, number][] = [[0, 0], [1, 0.2], [2, -0.1], [3, 0.05], [4, 0]];
    const out = douglasPeucker(line, 0.01);
    expect(out.length).toBeLessThanOrEqual(line.length);
  });
});

describe("segmentTrack — сегментация по разрывам", () => {
  const p = (t: number, extra: Partial<TrackFix> = {}): TrackFix => ({
    lng: BASE.lng,
    lat: BASE.lat,
    t,
    ...extra,
  });

  it("пустой вход — нет сегментов", () => {
    expect(segmentTrack([])).toEqual([]);
  });

  it("непрерывная последовательность — один сегмент", () => {
    const pts = [p(0), p(3000), p(6000), p(9000)];
    const segs = segmentTrack(pts, TRACK_GAP_MS);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toHaveLength(4);
  });

  it("разрыв по времени > порога — два сегмента", () => {
    // 0..6с идёт нормально, затем пауза 120с (уход в фон), потом продолжение.
    const pts = [p(0), p(3000), p(6000), p(126000), p(129000)];
    const segs = segmentTrack(pts, TRACK_GAP_MS);
    expect(segs).toHaveLength(2);
    expect(segs[0].map((f) => f.t)).toEqual([0, 3000, 6000]);
    expect(segs[1].map((f) => f.t)).toEqual([126000, 129000]);
  });

  it("интервал ровно на границе порога не рвёт линию", () => {
    const pts = [p(0), p(TRACK_GAP_MS)];
    expect(segmentTrack(pts, TRACK_GAP_MS)).toHaveLength(1);
  });

  it("явный маркер gapBefore рвёт сегмент даже при малом интервале", () => {
    // Точки идут часто (3с), но visibilitychange пометил разрыв перед 3-й.
    const pts = [p(0), p(3000), p(6000, { gapBefore: true }), p(9000)];
    const segs = segmentTrack(pts, TRACK_GAP_MS);
    expect(segs).toHaveLength(2);
    expect(segs[0].map((f) => f.t)).toEqual([0, 3000]);
    expect(segs[1].map((f) => f.t)).toEqual([6000, 9000]);
  });

  it("несколько разрывов — несколько сегментов", () => {
    const pts = [p(0), p(3000), p(60000), p(63000), p(200000)];
    const segs = segmentTrack(pts, TRACK_GAP_MS);
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.length)).toEqual([2, 2, 1]);
  });
});

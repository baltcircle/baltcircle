import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { measureAppHeight, nextAppHeight, type ViewportSample } from "./viewport-metrics";

const sample = (over: Partial<ViewportSample> = {}): ViewportSample => ({
  screenHeight: 844,
  innerHeight: 844,
  visualHeight: 844,
  clientHeight: 844,
  width: 390,
  floorEligible: true,
  ...over,
});

describe("measureAppHeight", () => {
  it("берёт максимум из доступных метрик", () => {
    expect(measureAppHeight(sample({ innerHeight: 751, visualHeight: 700 }))).toBe(844);
  });
});

describe("nextAppHeight", () => {
  it("первая метрика принимается как есть", () => {
    expect(nextAppHeight(null, sample())).toEqual({ width: 390, height: 844 });
  });

  it("не даёт высоте просесть при неизменной ширине", () => {
    // Ровно тот случай, ради которого введён пол: возврат из приложения банка
    // выдаёт заниженные метрики одним resize, а стабилизирующий resize следом
    // может не прийти — без пола шелл остаётся короче экрана.
    const settled = nextAppHeight(null, sample());
    const shrunk = nextAppHeight(
      settled,
      sample({ screenHeight: 714, innerHeight: 714, visualHeight: 714, clientHeight: 714 }),
    );
    expect(shrunk).toEqual({ width: 390, height: 844 });
  });

  it("смена ширины сбрасывает пол — это поворот экрана", () => {
    const portrait = nextAppHeight(null, sample());
    const landscape = nextAppHeight(
      portrait,
      sample({ width: 844, screenHeight: 390, innerHeight: 390, visualHeight: 390, clientHeight: 390 }),
    );
    expect(landscape).toEqual({ width: 844, height: 390 });
  });

  it("на десктопе окно можно сделать ниже — пол не применяется", () => {
    const first = nextAppHeight(null, sample({ floorEligible: false }));
    expect(
      nextAppHeight(
        first,
        sample({ floorEligible: false, screenHeight: 0, innerHeight: 600, visualHeight: 600, clientHeight: 600 }),
      ),
    ).toEqual({ width: 390, height: 600 });
  });

  it("растущая высота принимается сразу", () => {
    const first = nextAppHeight(null, sample({ screenHeight: 0, innerHeight: 751, visualHeight: 751, clientHeight: 751 }));
    expect(nextAppHeight(first, sample())).toEqual({ width: 390, height: 844 });
  });

  it("нулевая метрика не затирает известное значение", () => {
    const first = nextAppHeight(null, sample());
    expect(
      nextAppHeight(first, sample({ screenHeight: 0, innerHeight: 0, visualHeight: 0, clientHeight: 0 })),
    ).toEqual(first);
    expect(
      nextAppHeight(null, sample({ screenHeight: 0, innerHeight: 0, visualHeight: 0, clientHeight: 0 })),
    ).toBeNull();
  });
});

describe("контракт хука и карты", () => {
  const hookSource = readFileSync(
    resolve(__dirname, "../hooks/use-app-viewport.tsx"),
    "utf-8",
  );
  const mapSource = readFileSync(
    resolve(__dirname, "../components/MapLibreMap.tsx"),
    "utf-8",
  );

  it("шелл пересчитывает высоту при возврате из другого приложения", () => {
    // Возврат по deeplink из банка — единственный момент, когда метрики
    // приходят заниженными; без этих трёх подписок пересчёт может не случиться
    // вовсе, и карта останется короче экрана.
    for (const ev of ["pageshow", "focus", "visibilitychange"]) {
      expect(hookSource).toContain(`"${ev}", onRestore`);
    }
  });

  it("высота идёт через nextAppHeight, а не пишется напрямую", () => {
    expect(hookSource).toContain("nextAppHeight(heightRef.current, sample)");
    expect(hookSource).not.toContain("Math.max(\n        window.screen");
  });

  it("карта пересчитывает размер при возврате", () => {
    for (const ev of ["pageshow", "focus", "visibilitychange"]) {
      expect(mapSource).toContain(`"${ev}", onRestore`);
    }
  });
});

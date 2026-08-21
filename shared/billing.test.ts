import { describe, it, expect } from "vitest";
import { computeOverage, finalRideCost, formatKopecksAsRubles, overageMinuteKopecks } from "./billing";
import { OVERAGE_MINUTE_PRICE } from "./geo";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe("overageMinuteKopecks", () => {
  it("converts the ruble overage price to integer kopecks", () => {
    expect(overageMinuteKopecks()).toBe(OVERAGE_MINUTE_PRICE * 100);
  });
});

describe("computeOverage", () => {
  it("charges nothing for zero-duration rides", () => {
    expect(computeOverage(0, 2 * HOUR)).toEqual({ extraMinutes: 0, overageKopecks: 0 });
  });

  it("charges nothing when used time is within the paid window", () => {
    expect(computeOverage(HOUR, 2 * HOUR)).toEqual({ extraMinutes: 0, overageKopecks: 0 });
  });

  it("charges nothing exactly at the paid window boundary", () => {
    expect(computeOverage(2 * HOUR, 2 * HOUR)).toEqual({ extraMinutes: 0, overageKopecks: 0 });
  });

  it("charges one started minute just past the window", () => {
    const r = computeOverage(2 * HOUR + 1, 2 * HOUR);
    expect(r.extraMinutes).toBe(1);
    expect(r.overageKopecks).toBe(overageMinuteKopecks());
  });

  it("rounds a partial extra minute UP to a whole started minute", () => {
    const r = computeOverage(2 * HOUR + 61_000, 2 * HOUR); // 1m01s over
    expect(r.extraMinutes).toBe(2);
    expect(r.overageKopecks).toBe(2 * overageMinuteKopecks());
  });

  it("charges per whole started minute for multi-minute overage", () => {
    const r = computeOverage(2 * HOUR + 3 * MINUTE + 1, 2 * HOUR); // 3min+ over
    expect(r.extraMinutes).toBe(4);
    expect(r.overageKopecks).toBe(4 * overageMinuteKopecks());
  });

  it("treats a zero paid window (unknown/legacy tariff) as no overage", () => {
    expect(computeOverage(5 * HOUR, 0)).toEqual({ extraMinutes: 0, overageKopecks: 0 });
  });

  it("treats a negative paid window as no overage", () => {
    expect(computeOverage(5 * HOUR, -1)).toEqual({ extraMinutes: 0, overageKopecks: 0 });
  });
});

describe("finalRideCost", () => {
  it("adds overage to the prepaid base cost", () => {
    expect(finalRideCost(30000, 35000)).toBe(65000);
  });

  it("returns the base cost when there is no overage", () => {
    expect(finalRideCost(30000, 0)).toBe(30000);
  });

  it("keeps money in integer kopecks (no float drift)", () => {
    const base = 12345; // 123.45 ₽
    const over = overageMinuteKopecks();
    expect(Number.isInteger(finalRideCost(base, over))).toBe(true);
  });
});

describe("formatKopecksAsRubles", () => {
  it("omits a zero fractional part but keeps non-zero kopecks", () => {
    expect(formatKopecksAsRubles(15000)).toBe("150");
    expect(formatKopecksAsRubles(15050)).toBe("150.50");
  });
});

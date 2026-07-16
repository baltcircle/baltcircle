import { describe, it, expect } from "vitest";
import { computeOverage, finalRideCost, overageHourKopecks } from "./billing";
import { OVERAGE_HOUR_PRICE } from "./geo";

const HOUR = 60 * 60 * 1000;

describe("overageHourKopecks", () => {
  it("converts the ruble overage price to integer kopecks", () => {
    expect(overageHourKopecks()).toBe(OVERAGE_HOUR_PRICE * 100);
  });
});

describe("computeOverage", () => {
  it("charges nothing for zero-duration rides", () => {
    expect(computeOverage(0, 2 * HOUR)).toEqual({ extraHours: 0, overageKopecks: 0 });
  });

  it("charges nothing when used time is within the paid window", () => {
    expect(computeOverage(HOUR, 2 * HOUR)).toEqual({ extraHours: 0, overageKopecks: 0 });
  });

  it("charges nothing exactly at the paid window boundary", () => {
    expect(computeOverage(2 * HOUR, 2 * HOUR)).toEqual({ extraHours: 0, overageKopecks: 0 });
  });

  it("charges one started hour just past the window", () => {
    const r = computeOverage(2 * HOUR + 1, 2 * HOUR);
    expect(r.extraHours).toBe(1);
    expect(r.overageKopecks).toBe(overageHourKopecks());
  });

  it("rounds a partial extra hour UP to a whole started hour", () => {
    const r = computeOverage(2 * HOUR + 61_000, 2 * HOUR); // 1m01s over
    expect(r.extraHours).toBe(1);
    expect(r.overageKopecks).toBe(overageHourKopecks());
  });

  it("charges per whole started hour for multi-hour overage", () => {
    const r = computeOverage(2 * HOUR + 2 * HOUR + 1, 2 * HOUR); // 2h+ over
    expect(r.extraHours).toBe(3);
    expect(r.overageKopecks).toBe(3 * overageHourKopecks());
  });

  it("treats a zero paid window (unknown/legacy tariff) as no overage", () => {
    expect(computeOverage(5 * HOUR, 0)).toEqual({ extraHours: 0, overageKopecks: 0 });
  });

  it("treats a negative paid window as no overage", () => {
    expect(computeOverage(5 * HOUR, -1)).toEqual({ extraHours: 0, overageKopecks: 0 });
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
    const over = overageHourKopecks();
    expect(Number.isInteger(finalRideCost(base, over))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  tariffLabelForHours, tariffLabelForMinutes, tariffLabelForRide,
  tariffDurationMs, tariffPriceKopecks, TARIFFS,
} from "./geo";

describe("tariffLabelForHours", () => {
  it("reuses the catalog's own name for an exact tariff-duration match", () => {
    expect(tariffLabelForHours(1)).toBe("1 час");
    expect(tariffLabelForHours(2)).toBe("2 часа");
    expect(tariffLabelForHours(3)).toBe("3 часа");
  });

  it("falls back to correct Russian pluralization for totals with no matching catalog tariff", () => {
    expect(tariffLabelForHours(4)).toBe("4 часа");
    expect(tariffLabelForHours(5)).toBe("5 часов");
    expect(tariffLabelForHours(6)).toBe("6 часов");
    expect(tariffLabelForHours(21)).toBe("21 час");
    expect(tariffLabelForHours(22)).toBe("22 часа");
    expect(tariffLabelForHours(25)).toBe("25 часов");
  });

  it("applies the 11-14 exception (always \"часов\", even though they end in 1/2-4)", () => {
    expect(tariffLabelForHours(11)).toBe("11 часов");
    expect(tariffLabelForHours(12)).toBe("12 часов");
    expect(tariffLabelForHours(13)).toBe("13 часов");
    expect(tariffLabelForHours(14)).toBe("14 часов");
  });

  it("handles the degenerate 0-hour case (pre-fix legacy rows / never-extended default)", () => {
    expect(tariffLabelForHours(0)).toBe("0 часов");
  });

  // Temporary "m1" test tariff (1 minute / 10₽) — remove this describe block
  // together with the m1 catalog entry in ./geo.
  it("the m1 catalog entry has the correct price and a 1-minute duration override", () => {
    const m1 = TARIFFS.find((t) => t.id === "m1");
    expect(m1).toBeDefined();
    expect(tariffPriceKopecks(m1!)).toBe(1000);
    expect(tariffDurationMs("m1")).toBe(60_000);
    expect(m1!.durationHours).toBe(0);
    expect(m1!.test).toBe(true);
  });

  it("tariffLabelForHours(0) is NOT hijacked by m1's durationHours: 0", () => {
    // Regression guard: m1 must never match the generic exact-duration
    // lookup, since 0 already means "unknown legacy tariff" there.
    expect(tariffLabelForHours(0)).toBe("0 часов");
  });

  describe("tariffLabelForMinutes", () => {
    it("reuses the m1 catalog name for the 1-minute singular", () => {
      expect(tariffLabelForMinutes(1)).toBe("1 минута");
    });

    it("applies correct Russian pluralization", () => {
      expect(tariffLabelForMinutes(2)).toBe("2 минуты");
      expect(tariffLabelForMinutes(4)).toBe("4 минуты");
      expect(tariffLabelForMinutes(5)).toBe("5 минут");
      expect(tariffLabelForMinutes(8)).toBe("8 минут");
      expect(tariffLabelForMinutes(21)).toBe("21 минута");
    });

    it("applies the 11-14 exception", () => {
      expect(tariffLabelForMinutes(11)).toBe("11 минут");
      expect(tariffLabelForMinutes(12)).toBe("12 минут");
    });
  });

  describe("tariffLabelForRide", () => {
    it("resolves an m1-only, never-extended ride to its own name via totalTariffMs", () => {
      expect(tariffLabelForRide({ tariff: "m1", totalTariffMs: 60_000 })).toBe("1 минута");
    });

    // Regression guard for the actual bug report: extending a sub-hour
    // tariff (durationHours: 0) used to be invisible in the label because
    // totalTariffHours can't represent it at all — every extension added 0.
    // totalTariffMs has no such blind spot.
    it("reflects every extension of a sub-hour tariff, unlike the old hours-only counter", () => {
      expect(tariffLabelForRide({ tariff: "m1", totalTariffMs: 120_000 })).toBe("2 минуты");
      expect(tariffLabelForRide({ tariff: "m1", totalTariffMs: 480_000 })).toBe("8 минут");
    });

    it("falls back to the legacy label for a historical row predating totalTariffMs", () => {
      expect(tariffLabelForRide({ tariff: "m1", totalTariffMs: 0 })).toBe("1 минута");
    });

    it("still falls back to the generic zero label for a genuinely unknown legacy tariff", () => {
      expect(tariffLabelForRide({ tariff: "payg", totalTariffMs: 0 })).toBe("0 часов");
    });

    it("defers to the normal hours-based label once the cumulative total reaches an hour", () => {
      expect(tariffLabelForRide({ tariff: "h1", totalTariffMs: 60 * 60 * 1000 })).toBe("1 час");
      expect(tariffLabelForRide({ tariff: "h1", totalTariffMs: 2 * 60 * 60 * 1000 })).toBe("2 часа");
    });
  });
});

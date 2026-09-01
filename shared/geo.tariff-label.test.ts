import { describe, expect, it } from "vitest";
import { tariffLabelForHours } from "./geo";

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
});

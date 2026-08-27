import { describe, expect, it } from "vitest";
import type { Bike } from "@shared/schema";
import { extractBikeCode, normalizeCode, resolveScannedCode } from "./qr-scan-utils";

function makeBike(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "City Bicycle", status: "available", battery: 80,
    lat: 1, lng: 2, lastSeen: 0, idleHours: 0, flagged: false,
    parkingId: null,
    lockImei: null, lockOnline: false, lockLastSeen: null,
    notes: null, seed: false,
    ...overrides,
  } as Bike;
}

describe("extractBikeCode", () => {
  it("matches a plain BC code case-insensitively", () => {
    expect(extractBikeCode("bc-01")).toBe("BC-01");
    expect(extractBikeCode("BC001")).toBe("BC-001");
  });

  it("matches a BC code embedded in a URL path", () => {
    expect(extractBikeCode("https://takeride.ru/bike/BC-042")).toBe("BC-042");
    expect(extractBikeCode("https://takeride.ru/#/bike/BC-042")).toBe("BC-042");
  });

  it("matches a BC code in a query param", () => {
    expect(extractBikeCode("https://takeride.ru/scan?bike=BC-7")).toBe("BC-7");
    expect(extractBikeCode("https://takeride.ru/scan?id=BC-7")).toBe("BC-7");
  });

  it("returns null for a bare manufacturer serial number (no BC pattern)", () => {
    expect(extractBikeCode("1738907596")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractBikeCode("   ")).toBeNull();
  });

  it("matches a BC code typed with Cyrillic В/С (homoglyph keyboard layout)", () => {
    expect(extractBikeCode("ВС-014")).toBe("BC-014");
    expect(extractBikeCode("вс014")).toBe("BC-014");
    expect(extractBikeCode("Вc-7")).toBe("BC-7"); // mixed Cyrillic/Latin
  });
});

describe("normalizeCode", () => {
  it("canonicalizes to the BC-XXX shape", () => {
    expect(normalizeCode("bc1")).toBe("BC-1");
    expect(normalizeCode("BC-042")).toBe("BC-042");
  });
});

describe("resolveScannedCode", () => {
  it("resolves a normal BC code to the matching available bike", () => {
    const bikes = [makeBike({ id: "BC-01" }), makeBike({ id: "BC-02" })];
    const result = resolveScannedCode("BC-02", bikes);
    expect(result).toEqual({ bike: bikes[1] });
  });

  it("reports not-available when the matched bike isn't available, without silently falling through", () => {
    const bikes = [makeBike({ id: "BC-01", status: "rented" })];
    const result = resolveScannedCode("BC-01", bikes);
    expect(result).toEqual({ error: "not-available" });
  });

  it("reports not-found for unrecognized raw text", () => {
    const bikes = [makeBike({ id: "BC-01" })];
    const result = resolveScannedCode("garbage-text", bikes);
    expect(result).toEqual({ error: "not-found" });
  });
});

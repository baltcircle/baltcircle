import { describe, expect, it } from "vitest";
import type { Bike } from "@shared/schema";
import { extractBikeCode, normalizeCode, resolveScannedCode } from "./qr-scan-utils";

function makeBike(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "City Bicycle", status: "available", battery: 80,
    lat: 1, lng: 2, lastSeen: 0, idleHours: 0, flagged: false,
    serial: null, lockId: null, parkingId: null,
    lockImei: null, lockOnline: false, lockLastSeen: null,
    notes: null, seed: false,
    externalQrCode: null, isTestBike: false,
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

  it("falls back to externalQrCode for a manufacturer-printed lock QR", () => {
    const testBike = makeBike({ id: "BC-01", externalQrCode: "1738907596", isTestBike: true });
    const bikes = [testBike, makeBike({ id: "BC-02" })];
    const result = resolveScannedCode("1738907596", bikes);
    expect(result).toEqual({ bike: testBike });
  });

  it("does not match externalQrCode against a bike that has none set", () => {
    const bikes = [makeBike({ id: "BC-01", externalQrCode: null })];
    const result = resolveScannedCode("1738907596", bikes);
    expect(result).toEqual({ error: "not-found" });
  });

  it("reports not-available when the matched bike isn't available, without silently falling through", () => {
    const bikes = [makeBike({ id: "BC-01", status: "rented" })];
    const result = resolveScannedCode("BC-01", bikes);
    expect(result).toEqual({ error: "not-available" });
  });

  it("reports not-available for a rented test bike matched by its external QR", () => {
    const bikes = [makeBike({ id: "BC-01", externalQrCode: "1738907596", isTestBike: true, status: "maintenance" })];
    const result = resolveScannedCode("1738907596", bikes);
    expect(result).toEqual({ error: "not-available" });
  });

  it("reports not-found for unrecognized raw text", () => {
    const bikes = [makeBike({ id: "BC-01" })];
    const result = resolveScannedCode("garbage-text", bikes);
    expect(result).toEqual({ error: "not-found" });
  });
});

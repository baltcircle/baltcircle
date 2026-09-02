import { describe, expect, it } from "vitest";
import type { Bike } from "@shared/schema";
import { extractBikeCode, normalizeCode, classifyBikeForScan } from "./qr-scan-utils";

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

describe("classifyBikeForScan", () => {
  it("resolves an available bike regardless of ownership", () => {
    const bike = makeBike({ id: "BC-01", status: "available" });
    expect(classifyBikeForScan(bike, {})).toEqual({ bike });
  });

  it("lets the scanning rider's own rented bike through", () => {
    const bike = makeBike({ id: "BC-01", status: "rented" });
    const result = classifyBikeForScan(bike, { myActiveRideBikeId: "BC-01" });
    expect(result).toEqual({ bike });
  });

  it("reports \u00ab\u0432 \u0430\u0440\u0435\u043d\u0434\u0435\u00bb for a bike rented by someone else", () => {
    const bike = makeBike({ id: "BC-01", status: "rented" });
    const result = classifyBikeForScan(bike, { myActiveRideBikeId: "BC-02" });
    expect(result).toEqual({ error: "\u0412\u0435\u043b\u043e\u0441\u0438\u043f\u0435\u0434 \u043d\u0430\u0445\u043e\u0434\u0438\u0442\u044c\u0441\u044f \u0432 \u0430\u0440\u0435\u043d\u0434\u0435" });
  });

  it("lets the scanning rider's own reservation through", () => {
    const bike = makeBike({ id: "BC-01", status: "reserved" });
    const result = classifyBikeForScan(bike, { myReservationBikeId: "BC-01" });
    expect(result).toEqual({ bike });
  });

  it("reports \u00ab\u0437\u0430\u0431\u0440\u043e\u043d\u0438\u0440\u043e\u0432\u0430\u043d\u00bb for a bike reserved by someone else", () => {
    const bike = makeBike({ id: "BC-01", status: "reserved" });
    const result = classifyBikeForScan(bike, { myReservationBikeId: "BC-02" });
    expect(result).toEqual({ error: "\u0412\u0435\u043b\u043e\u0441\u0438\u043f\u0435\u0434 \u0437\u0430\u0431\u0440\u043e\u043d\u0438\u0440\u043e\u0432\u0430\u043d" });
  });

  it("reports a generic \u00ab\u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d\u00bb for every other out-of-rotation status", () => {
    for (const status of ["maintenance", "offline", "storage", "sleeping", "lost", "archived"] as const) {
      const bike = makeBike({ id: "BC-01", status });
      expect(classifyBikeForScan(bike, {})).toEqual({
        error: "\u0412\u0435\u043b\u043e\u0441\u0438\u043f\u0435\u0434 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d",
      });
    }
  });
});

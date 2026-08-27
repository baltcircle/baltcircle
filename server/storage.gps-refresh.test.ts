// Unit coverage for IBikeStorage.applyGpsRefresh (server/storage/bike.ts) —
// the storage-layer half of the opportunistic GPS-refresh feature. The OMNI
// TCP side (registry, requestGpsRefresh, early-stop) is covered end-to-end in
// server/omni/server.gps-refresh.test.ts and server/omni/store.gps-refresh.test.ts;
// this file only exercises applyGpsRefresh's own guards and effects.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike } from "@shared/schema";
import { realToMap } from "@shared/geo";

const IMEI = "861234567890123";
const OTHER_IMEI = "861234567890999";

let selectResults: unknown[][] = [];
let updateSets: unknown[] = [];

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));

import { storage } from "./storage";

function bikeRow(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "City", status: "available", battery: 100,
    lat: 100, lng: 100, lastSeen: 0, idleHours: 0, flagged: false,
    lockImei: IMEI, lockOnline: false,
    lockLastSeen: null, parkingId: null, notes: null, seed: false,
    ...overrides,
  } as Bike;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  updateSets = [];

  dbMock.select.mockImplementation(() => {
    const rows = selectResults.shift() ?? [];
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return chain;
  });
  dbMock.update.mockImplementation(() => {
    const chain: any = {
      set: (v: unknown) => { updateSets.push(v); return chain; },
      where: () => Promise.resolve(),
    };
    return chain;
  });
  poolMock.query.mockResolvedValue({ rows: [] });
});

describe("applyGpsRefresh", () => {
  it("updates the bike's position (converted via realToMap) and recalculates parking, for an ordinary parked bike", async () => {
    const bike = bikeRow({ status: "maintenance" });
    // getBike (existing) -> getBike (post-updateBike readback)
    selectResults = [[bike], [{ ...bike, lat: 999, lng: 999 }]];
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);

    await storage.applyGpsRefresh({ bikeId: "BC-01", imei: IMEI, lat: 54.71, lng: 20.51 });

    const expected = realToMap(54.71, 20.51);
    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]).toEqual({ lat: expected.y, lng: expected.x });
    expect(recalcSpy).toHaveBeenCalledTimes(1);
    expect(recalcSpy.mock.calls[0][0]).toMatchObject({ id: "BC-01", lat: 999, lng: 999 });
  });

  it("is a no-op when the bike no longer exists", async () => {
    selectResults = [[]]; // getBike -> undefined
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);

    await storage.applyGpsRefresh({ bikeId: "missing", imei: IMEI, lat: 54.71, lng: 20.51 });

    expect(updateSets).toHaveLength(0);
    expect(recalcSpy).not.toHaveBeenCalled();
  });

  it("skips a bike that is mid-ride (rented) — the ride owns its position", async () => {
    selectResults = [[bikeRow({ status: "rented" })]];
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);

    await storage.applyGpsRefresh({ bikeId: "BC-01", imei: IMEI, lat: 54.71, lng: 20.51 });

    expect(updateSets).toHaveLength(0);
    expect(recalcSpy).not.toHaveBeenCalled();
  });

  it("skips an archived (soft-deleted) bike", async () => {
    selectResults = [[bikeRow({ status: "archived" })]];
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);

    await storage.applyGpsRefresh({ bikeId: "BC-01", imei: IMEI, lat: 54.71, lng: 20.51 });

    expect(updateSets).toHaveLength(0);
    expect(recalcSpy).not.toHaveBeenCalled();
  });

  it("skips when the bike's lock has since been swapped to a different IMEI", async () => {
    selectResults = [[bikeRow({ status: "available", lockImei: OTHER_IMEI })]];
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);

    await storage.applyGpsRefresh({ bikeId: "BC-01", imei: IMEI, lat: 54.71, lng: 20.51 });

    expect(updateSets).toHaveLength(0);
    expect(recalcSpy).not.toHaveBeenCalled();
  });
});

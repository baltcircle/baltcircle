import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike, Parking, Ride } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), transaction: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: vi.fn() }));

import { storage } from "./storage";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function bikeRow(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "City", status: "maintenance", battery: 100,
    lat: 350, lng: 217, lastSeen: 0, idleHours: 0, flagged: false,
    serial: null, lockId: null, lockImei: null, lockOnline: false,
    lockLastSeen: null, parkingId: "P-old", notes: null, seed: false,
    ...overrides,
  } as Bike;
}

function parkingRow(overrides: Partial<Parking> = {}): Parking {
  return {
    id: "P-new", name: "New parking", city: "Калининград", lat: 350, lng: 215,
    capacity: 10, occupied: 0, radius: 30, status: "active", notes: null,
    archivedAt: null, seed: false, createdAt: null, updatedAt: null,
    ...overrides,
  } as Parking;
}

function rideRow(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 42, bikeId: "BC-01", userId: "user-1", startedAt: NOW.getTime(), endedAt: null,
    startLat: 350, startLng: 217, endLat: null, endLng: null,
    track: JSON.stringify([[217, 350, NOW.getTime()]]), distanceM: 0,
    cost: 35000, tariff: "h1", status: "active", ...overrides,
  } as Ride;
}

function selectFrom(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    for: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [] });
});

afterEach(() => vi.useRealTimers());

describe("automatic parking assignment on availability transitions", () => {
  it("sets the nearest eligible parking after a ride ends", async () => {
    const completed = rideRow({ status: "completed", endedAt: NOW.getTime() });
    // Phase 2 (radius-gating): endRide now selects the bike row (for lockImei)
    // right after the ride row. bikeRow() defaults to lockImei: null, so the
    // hard-block/lock-GPS branch is skipped and this fixture keeps exercising
    // the pre-Phase-2 fallback: last track point + parking-radius assignment.
    const selectResults: unknown[][] = [[rideRow()], [bikeRow()], [parkingRow()], [completed]];
    const setCalls: unknown[] = [];
    const tx: any = {
      select: vi.fn(() => selectFrom(selectResults.shift() ?? [])),
      update: vi.fn(() => {
        const chain: any = { set: (value: unknown) => { setCalls.push(value); return chain; }, where: () => Promise.resolve() };
        return chain;
      }),
      insert: vi.fn(() => ({ values: () => Promise.resolve() })),
      // Audit HIGH #15: endRide now loads ride_points via tx.execute() (was a
      // separate pool.query) — the tx mock must implement it too.
      execute: vi.fn(() => Promise.resolve({ rows: [] })),
    };
    dbMock.transaction.mockImplementation((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));

    await storage.endRide(42);

    expect(setCalls).toContainEqual(expect.objectContaining({ parkingId: "P-new" }));
  });

  it("clears parkingId when a ride ends outside every parking radius", async () => {
    const completed = rideRow({ status: "completed", endedAt: NOW.getTime() });
    const farParking = parkingRow({ lng: 200, radius: 30 });
    // See note above — bikeRow() has lockImei: null, so this keeps the legacy
    // (non-hard-blocked) endRide path with the phone track's last point.
    const selectResults: unknown[][] = [[rideRow()], [bikeRow()], [farParking], [completed]];
    const setCalls: unknown[] = [];
    const tx: any = {
      select: vi.fn(() => selectFrom(selectResults.shift() ?? [])),
      update: vi.fn(() => {
        const chain: any = { set: (value: unknown) => { setCalls.push(value); return chain; }, where: () => Promise.resolve() };
        return chain;
      }),
      insert: vi.fn(() => ({ values: () => Promise.resolve() })),
      // Audit HIGH #15: endRide now loads ride_points via tx.execute() (was a
      // separate pool.query) — the tx mock must implement it too.
      execute: vi.fn(() => Promise.resolve({ rows: [] })),
    };
    dbMock.transaction.mockImplementation((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx));

    await storage.endRide(42);

    expect(setCalls).toContainEqual(expect.objectContaining({ parkingId: null }));
  });

  it("replaces a manual PATCH assignment with the GPS-matched parking when status becomes available", async () => {
    const updated = bikeRow({ status: "available", parkingId: "P-new" });
    const selectResults: unknown[][] = [[bikeRow()], [parkingRow()], [], [], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: (value: unknown) => { setSpy(value); return chain; }, where: () => Promise.resolve() };
      return chain;
    });

    await storage.adminUpdateBike("BC-01", { status: "available", parkingId: "P-operator-choice" });

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ parkingId: "P-new" }));
  });

  it("clears a manual PATCH assignment when the current GPS position is outside every radius", async () => {
    const updated = bikeRow({ status: "available", parkingId: null });
    const selectResults: unknown[][] = [[bikeRow()], [parkingRow({ lng: 200 })], [], [], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: (value: unknown) => { setSpy(value); return chain; }, where: () => Promise.resolve() };
      return chain;
    });

    await storage.adminUpdateBike("BC-01", { status: "available", parkingId: "P-operator-choice" });

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ parkingId: null }));
  });
});

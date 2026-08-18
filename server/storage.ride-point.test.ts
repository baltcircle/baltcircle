// Tests for appendRidePoint()'s atomicity fix (audit: слой данных, "appendRidePoint
// неатомарен"). The Drizzle client and pool are mocked, so this runs without
// Postgres — it verifies the TS-side contract: the ride row is locked with
// `.for("update")` for the duration of the read-last-point/insert/update
// sequence, the guard on ride.status is respected, and the distance delta is
// computed from whatever "last point" the (locked) transaction sees.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ride } from "@shared/schema";
import { bikes, rides } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn(), execute: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));

import { storage, rideEvents } from "./storage";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function makeRide(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 42,
    bikeId: "BC-01",
    userId: "user-1",
    startedAt: NOW.getTime() - 1000,
    endedAt: null,
    startLat: 350,
    startLng: 217,
    endLat: null,
    endLng: null,
    track: JSON.stringify([[217, 350, NOW.getTime() - 1000]]),
    distanceM: 0,
    cost: 35000,
    tariff: "h1",
    status: "active",
    ...overrides,
  } as Ride;
}

/**
 * Builds a tx mock. `rideRows` answers the `.for("update")` select on
 * `rides`; `lastPointRows` answers the "last stored ride_points row" read.
 * Records whether the row lock (`for`) was actually invoked, and every
 * update/insert issued inside the transaction.
 */
function makeTx(rideRows: unknown[], lastPointRows: { x: number; y: number; t: number }[]) {
  const calls = {
    forCalled: false,
    updateRides: [] as unknown[],
    updateBikes: [] as unknown[],
    insertSql: [] as unknown[],
  };
  const executeQueue: { rows: unknown[] }[] = [{ rows: lastPointRows }, { rows: [] }];
  const tx: any = {
    select: vi.fn(() => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        for: (mode: string) => {
          calls.forCalled = mode === "update";
          return chain;
        },
        limit: () => Promise.resolve(rideRows),
      };
      return chain;
    }),
    execute: vi.fn((query: unknown) => {
      calls.insertSql.push(query);
      return Promise.resolve(executeQueue.shift() ?? { rows: [] });
    }),
    update: vi.fn((table: unknown) => {
      const chain: any = {
        set: (patch: unknown) => {
          if (table === bikes) calls.updateBikes.push(patch);
          else if (table === rides) calls.updateRides.push(patch);
          return chain;
        },
        where: () => Promise.resolve(),
      };
      return chain;
    }),
  };
  return { tx, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [] });
  // getRide()/hydrateTrack() at the end of appendRidePoint re-reads the ride
  // outside the transaction — answer that plain db.select() too.
  dbMock.select.mockImplementation(() => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve([makeRide({ distanceM: 30 })]),
    };
    return chain;
  });
  // hydrateTrack() re-reads ride_points OUTSIDE the transaction on the plain
  // `db` (only reached for still-active rides) — answer it too.
  dbMock.execute.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("appendRidePoint — atomicity (audit: слой данных)", () => {
  it("locks the ride row with FOR UPDATE before reading the last point", async () => {
    const { tx, calls } = makeTx([makeRide()], []);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.appendRidePoint(42, 220, 352);

    expect(calls.forCalled).toBe(true);
  });

  it("returns undefined and writes nothing when the ride is missing", async () => {
    const { tx, calls } = makeTx([], []);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const emitSpy = vi.spyOn(rideEvents, "emit");

    const result = await storage.appendRidePoint(999, 1, 1);

    expect(result).toBeUndefined();
    expect(tx.update).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("returns undefined and writes nothing when the ride is no longer active", async () => {
    const { tx } = makeTx([makeRide({ status: "completed" })], []);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.appendRidePoint(42, 1, 1);

    expect(result).toBeUndefined();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("computes the distance delta from the last stored point and appends the new one inside the same lock", async () => {
    // Last stored point at (217, 350); new point at (220, 350) -> dx=3, dy=0.
    const { tx, calls } = makeTx([makeRide({ distanceM: 100 })], [{ x: 217, y: 350, t: NOW.getTime() - 500 }]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.appendRidePoint(42, 220, 350);

    // 3 map units * 30 m/unit = 90m added to the existing 100m.
    expect(calls.updateRides).toContainEqual({ distanceM: 190 });
    expect(calls.updateBikes).toContainEqual(
      expect.objectContaining({ lat: 350, lng: 220 }),
    );
  });

  it("falls back to the ride's start position when no ride_points row exists yet", async () => {
    const { tx, calls } = makeTx([makeRide({ distanceM: 0, startLat: 350, startLng: 217 })], []);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.appendRidePoint(42, 217, 350);

    expect(calls.updateRides).toContainEqual({ distanceM: 0 });
  });

  it("emits a rider point event and invalidates the bikes cache only on a real write", async () => {
    const { tx } = makeTx([makeRide()], []);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const emitSpy = vi.spyOn(rideEvents, "emit");
    const cacheSpy = vi.spyOn(storage, "invalidateBikesCache").mockImplementation(() => {});

    await storage.appendRidePoint(42, 220, 352);

    expect(emitSpy).toHaveBeenCalledWith("user-1", "point");
    expect(cacheSpy).toHaveBeenCalledWith({ silent: true });
  });
});

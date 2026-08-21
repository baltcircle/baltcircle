import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike, Ride } from "@shared/schema";

// Audit F-04: /api/rides/start must not leave a rider charged for a bike whose
// physical smart lock never confirmed the unlock. These tests exercise
// storage.startRide's post-commit unlock dispatch + compensating rollback in
// isolation from a real Postgres/OMNI gateway, following the mocking pattern
// already established in storage.ride-end.test.ts.

const dbMock = vi.hoisted(() => ({ transaction: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
const sendToUserAsyncMock = vi.hoisted(() => vi.fn());
const sendUnlockCommandMock = vi.hoisted(() => vi.fn());
const getLockGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: sendToUserAsyncMock }));
vi.mock("./omni/gateway", () => ({ getLockGateway: getLockGatewayMock }));

import { storage } from "./storage";

const NOW = new Date("2026-08-17T12:00:00.000Z");

function makeBike(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "Cruiser", status: "available", battery: 80,
    lat: 1, lng: 2, lastSeen: NOW.getTime(), idleHours: 0, flagged: false,
    serial: null, lockId: null, parkingId: null,
    lockImei: null, lockOnline: false, lockLastSeen: null,
    notes: null, seed: false,
    externalQrCode: null, isTestBike: false,
    ...overrides,
  } as Bike;
}

function makeRide(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 7, bikeId: "BC-01", userId: "user-1", startedAt: NOW.getTime(), endedAt: null,
    startLat: 1, startLng: 2, endLat: null, endLng: null,
    track: JSON.stringify([[2, 1, NOW.getTime()]]), distanceM: 0,
    cost: 35000, tariff: "h1", status: "active", physicallyLockedAt: null,
    ...overrides,
  } as Ride;
}

// Radius-gating (Phase 2): startRide now hard-requires the bike to be inside
// an active parking zone. Every makeBike() fixture in this file sits at
// (lat: 1, lng: 2) and never overrides it, and every test's lock-row select
// below returns no fix, so startRide always falls back to matching against
// this exact position — a single generous-radius zone centred there keeps
// every existing fixture passing the new geofence check.
function makeParking(overrides: Record<string, unknown> = {}) {
  return { id: "P-1", lat: 1, lng: 2, radius: 999999, status: "active", archivedAt: null, ...overrides };
}

// Builds a fake `tx` whose `select()` calls consume `selectQueue` in order,
// mirroring the real call sequence: [bike] -> [activeRideCheck] -> (lockImei
// set only) [lockRow] -> [parkingsForStart] -> (on rollback) [rideForUpdate].
// Table identity isn't compared — instead each update/insert is classified by
// the shape of the values it writes, which is unambiguous for this code path
// (only the rides-cancel update sets status:"cancelled"; only the bikes-free
// update sets status:"available"; only the wallet-topup insert has kind
// "ride_charge" with a positive amount).
//
// Radius-gating (Phase 2): the parkings lookup (`await tx.select().from(parkings)`)
// awaits the chain directly, without ever calling `.limit()` — unlike every
// other select in this code path. The chain must therefore be awaitable on
// its own (a `then()`), or that bare await resolves to the chain object
// itself instead of the queued rows.
function makeTx(selectQueue: unknown[][]) {
  const calls = { execute: [] as unknown[], updateSets: [] as unknown[], insertValues: [] as unknown[] };
  const tx: any = {
    select: vi.fn(() => {
      const rows = selectQueue.shift() ?? [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        for: () => chain,
        limit: () => Promise.resolve(rows),
        then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    }),
    update: vi.fn(() => ({
      set: (values: unknown) => {
        calls.updateSets.push(values);
        return { where: () => Promise.resolve() };
      },
    })),
    insert: vi.fn(() => ({
      values: (values: any) => {
        calls.insertValues.push(values);
        if (values && "bikeId" in values && "startedAt" in values) {
          return { returning: () => Promise.resolve([makeRide()]) };
        }
        return Promise.resolve();
      },
    })),
    execute: vi.fn((query: any) => {
      // drizzle's sql`` template tag builds an object whose readable text is
      // only recoverable via .toQuery() — String(query) gives "[object Object]".
      const sqlText = typeof query?.toQuery === "function"
        ? query.toQuery({ escapeParam: (i: number) => "$" + i }).sql
        : String(query);
      calls.execute.push(sqlText);
      if (sqlText.includes("UPDATE wallet") && sqlText.includes("balance -")) {
        return Promise.resolve({ rows: [{ balance: 100000 }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
  return { tx, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startRide physical unlock gate (audit F-04)", () => {
  it("skips the unlock command entirely for a bike with no smart lock bound", async () => {
    const bike = makeBike({ lockImei: null });
    // No lockImei -> the transaction never selects `locks`, so the 3rd queued
    // select is the radius-gating parkings lookup, not a lockRow.
    const { tx } = makeTx([[bike], [], [makeParking()]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1", prepaid: true });

    expect(getLockGatewayMock).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("error");
  });

  it("tags the created ride isTest when started on a bike flagged isTestBike, without any client-supplied flag", async () => {
    // Test-lock feature: the tag is derived solely from the locked bike row,
    // never from the caller's input — startRide's params take no isTest field
    // at all, so there is nothing for a forged request to override.
    const bike = makeBike({ lockImei: null, isTestBike: true, externalQrCode: "1738907596" });
    const { tx, calls } = makeTx([[bike], [], [makeParking()]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1", prepaid: true });

    expect(result).not.toHaveProperty("error");
    const rideInsert = calls.insertValues.find((v: any) => v && "bikeId" in v && "startedAt" in v);
    expect(rideInsert).toMatchObject({ isTest: true });
  });

  it("leaves isTest false for a normal bike", async () => {
    const bike = makeBike({ lockImei: null, isTestBike: false });
    const { tx, calls } = makeTx([[bike], [], [makeParking()]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1", prepaid: true });

    expect(result).not.toHaveProperty("error");
    const rideInsert = calls.insertValues.find((v: any) => v && "bikeId" in v && "startedAt" in v);
    expect(rideInsert).toMatchObject({ isTest: false });
  });

  it("keeps the ride active when the lock confirms the unlock", async () => {
    const bike = makeBike({ lockImei: "868000000000001" });
    // lockImei set -> the transaction also selects `locks` (empty = no fix
    // yet, falls back to matching against the bike's own lat/lng) before the
    // parkings lookup.
    const { tx } = makeTx([[bike], [], [], [makeParking()]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    sendUnlockCommandMock.mockResolvedValue({ success: true });
    getLockGatewayMock.mockReturnValue({ sendUnlockCommand: sendUnlockCommandMock });

    const result = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1", prepaid: true });

    expect(sendUnlockCommandMock).toHaveBeenCalledWith("868000000000001", "user-1");
    expect(result).not.toHaveProperty("error");
  });

  it("rolls back and refunds the internal wallet debit when the lock is not connected", async () => {
    const bike = makeBike({ lockImei: "868000000000001" });
    const startedRide = makeRide({ cost: 35000 });
    const activeRideForRollback = makeRide({ cost: 35000, status: "active" });
    // startRide's own tx consumes 4 selects (bike, activeRideCheck, lockRow,
    // parkings); abortUnstartedRide's separate db.transaction call then reuses
    // the same tx mock and consumes the 5th (the ride row it re-selects
    // `.for("update")` before cancelling it).
    const { tx, calls } = makeTx([[bike], [], [], [makeParking()], [activeRideForRollback]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    getLockGatewayMock.mockReturnValue(null); // gateway not running

    const result = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1", prepaid: false });

    expect(result).toHaveProperty("error");
    // Ride flipped to cancelled, bike flipped back to available.
    expect(calls.updateSets.some((v: any) => v.status === "cancelled")).toBe(true);
    expect(calls.updateSets.some((v: any) => v.status === "available")).toBe(true);
    // Wallet credited back for the internal (non-prepaid) debit.
    expect(calls.execute.some((q) => String(q).includes("UPDATE wallet") && String(q).includes("balance +"))).toBe(true);
  });

  it("rolls back the ride but does NOT touch the wallet for a prepaid (T-Bank) ride when unlock fails", async () => {
    const bike = makeBike({ lockImei: "868000000000001" });
    const startedRide = makeRide({ cost: 35000 });
    const activeRideForRollback = makeRide({ cost: 35000, status: "active" });
    const { tx, calls } = makeTx([[bike], [], [], [makeParking()], [activeRideForRollback]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    sendUnlockCommandMock.mockResolvedValue({ success: false });
    getLockGatewayMock.mockReturnValue({ sendUnlockCommand: sendUnlockCommandMock });

    const result = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1", prepaid: true });

    expect(result).toHaveProperty("error");
    expect(calls.execute.some((q) => String(q).includes("UPDATE wallet") && String(q).includes("balance +"))).toBe(false);
  });

  it("treats a throwing sendUnlockCommand the same as a rejected unlock", async () => {
    const bike = makeBike({ lockImei: "868000000000001" });
    const startedRide = makeRide({ cost: 35000 });
    const activeRideForRollback = makeRide({ cost: 35000, status: "active" });
    const { tx } = makeTx([[bike], [], [], [makeParking()], [activeRideForRollback]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    sendUnlockCommandMock.mockRejectedValue(new Error("unlock command timed out"));
    getLockGatewayMock.mockReturnValue({ sendUnlockCommand: sendUnlockCommandMock });

    const result = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1", prepaid: false });

    expect(result).toHaveProperty("error");
  });
});

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
import { setLockGateway } from "./omni/gateway";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function bikeRow(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "City", status: "maintenance", battery: 100,
    lat: 350, lng: 217, lastSeen: 0, idleHours: 0, flagged: false,
    lockImei: null, lockOnline: false,
    lockLastSeen: null, parkingId: "P-old", notes: null, seed: false,
    ...overrides,
  } as Bike;
}

function lockRow(overrides: Record<string, unknown> = {}) {
  return { imei: "IMEI-1", lastLockState: "locked", ...overrides };
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
  // endRide's pre-transaction funding-order lookup (see
  // chargeRideOverageAsync in server/storage/ride.ts) uses the module-level
  // db.select (not tx.select) — default to "none found" so the two
  // endRide-driven tests below keep exercising the legacy wallet path via
  // their tx-scoped selectResults queues, unaffected by this extra call.
  dbMock.select.mockImplementation(() => selectFrom([]));
});

afterEach(() => {
  vi.useRealTimers();
  setLockGateway(null);
});

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

  it("re-derives parkingId from GPS on a non-available status change with no explicit parkingId in the PATCH", async () => {
    // Bug fix: previously only the transition INTO "available" recalculated
    // parkingId, even though every status change syncs lat/lng from the
    // lock's live GPS fix. A bike moved to a new spot during e.g.
    // available -> offline must not keep pointing at its old parking.
    // Real-world coords that round-trip to map point (217, 350) via
    // realToMap() — inside parkingRow()'s default radius (lat:350, lng:215, radius:30).
    const lockRow = { imei: "IMEI-1", lastLatitude: 54.9442, lastLongitude: 20.156381515574246 } as any;
    const bike = bikeRow({ status: "available", lockImei: "IMEI-1", parkingId: "P-old" });
    const updated = bikeRow({ status: "offline", lockImei: "IMEI-1", parkingId: "P-new" });
    const selectResults: unknown[][] = [[bike], [lockRow], [parkingRow()], [], [], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: (value: unknown) => { setSpy(value); return chain; }, where: () => Promise.resolve() };
      return chain;
    });

    await storage.adminUpdateBike("BC-01", { status: "offline" });

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ parkingId: "P-new" }));
  });

  it("honors an explicit parkingId override in the PATCH on a non-available status change", async () => {
    const bike = bikeRow({ status: "available", lockImei: null, parkingId: "P-old" });
    const updated = bikeRow({ status: "offline", parkingId: "P-operator-choice" });
    const selectResults: unknown[][] = [[bike], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: (value: unknown) => { setSpy(value); return chain; }, where: () => Promise.resolve() };
      return chain;
    });

    await storage.adminUpdateBike("BC-01", { status: "offline", parkingId: "P-operator-choice" });

    // No parkings/bikes select should happen — recalculateBikeParking must be skipped.
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ parkingId: "P-operator-choice" }));
    expect(setSpy).not.toHaveBeenCalledWith(expect.objectContaining({ parkingId: "P-new" }));
  });
});

describe("one-shot parking recalc arming on the into-available transition (bike-status lifecycle spec, 2026-09)", () => {
  it("arms a recalc when a locked bike enters available from a slower-cadence status (maintenance, 3600s > 120s)", async () => {
    const bike = bikeRow({ status: "maintenance", lockImei: "IMEI-1" });
    const updated = bikeRow({ status: "available", lockImei: "IMEI-1", parkingId: "P-new" });
    // getBike(existing) -> assertLockClosedForAvailable's locks lookup (lock is
    // closed, so the transition proceeds) -> resolveLockPositionForBikeStatusChange's
    // locks lookup (no last-known fix) -> listParkings() -> getBike() inside
    // updateBike's parkingId patch -> final getBike(workingId).
    const selectResults: unknown[][] = [[bike], [lockRow()], [], [parkingRow()], [], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    const armParkingRecalc = vi.fn();
    setLockGateway({ armParkingRecalc } as any);

    await storage.adminUpdateBike("BC-01", { status: "available" });

    expect(armParkingRecalc).toHaveBeenCalledWith("IMEI-1", "BC-01");
  });

  it("does not arm a recalc entering available from an already-fast-cadence status (reserved, 10s)", async () => {
    const bike = bikeRow({ status: "reserved", lockImei: "IMEI-1" });
    const updated = bikeRow({ status: "available", lockImei: "IMEI-1", parkingId: "P-new" });
    const selectResults: unknown[][] = [[bike], [lockRow()], [], [parkingRow()], [], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    const armParkingRecalc = vi.fn();
    setLockGateway({ armParkingRecalc } as any);

    await storage.adminUpdateBike("BC-01", { status: "available" });

    expect(armParkingRecalc).not.toHaveBeenCalled();
  });

  it("does not arm a recalc when the bike has no lock attached", async () => {
    const bike = bikeRow({ status: "maintenance", lockImei: null });
    const updated = bikeRow({ status: "available", lockImei: null, parkingId: "P-new" });
    // No lockImei -> resolveLockPositionForBikeStatusChange skips its select entirely.
    const selectResults: unknown[][] = [[bike], [parkingRow()], [], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    const armParkingRecalc = vi.fn();
    setLockGateway({ armParkingRecalc } as any);

    await storage.adminUpdateBike("BC-01", { status: "available" });

    expect(armParkingRecalc).not.toHaveBeenCalled();
  });

  it("does not arm a recalc on a non-available status change", async () => {
    const bike = bikeRow({ status: "available", lockImei: "IMEI-1" });
    const updated = bikeRow({ status: "offline", lockImei: "IMEI-1", parkingId: "P-new" });
    const selectResults: unknown[][] = [[bike], [], [parkingRow()], [], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    const armParkingRecalc = vi.fn();
    setLockGateway({ armParkingRecalc } as any);

    await storage.adminUpdateBike("BC-01", { status: "offline" });

    expect(armParkingRecalc).not.toHaveBeenCalled();
  });

  it("is a safe no-op when no gateway is registered (e.g. in tests or before the TCP server starts)", async () => {
    const bike = bikeRow({ status: "maintenance", lockImei: "IMEI-1" });
    const updated = bikeRow({ status: "available", lockImei: "IMEI-1", parkingId: "P-new" });
    const selectResults: unknown[][] = [[bike], [lockRow()], [], [parkingRow()], [], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });

    await expect(storage.adminUpdateBike("BC-01", { status: "available" })).resolves.not.toThrow();
  });
});

describe("blocks entering \"available\" while the lock is physically open (2026-09 lock-state guard)", () => {
  it("rejects the transition when the lock's last reported state is unlocked", async () => {
    const bike = bikeRow({ status: "maintenance", lockImei: "IMEI-1" });
    const selectResults: unknown[][] = [[bike], [lockRow({ lastLockState: "unlocked" })]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: (v: unknown) => { setSpy(v); return chain; }, where: () => Promise.resolve() };
      return chain;
    });

    const result = await storage.adminUpdateBike("BC-01", { status: "available" });

    expect(result).toEqual({ error: expect.stringContaining("замок открыт") });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the lock has never reported a state (null)", async () => {
    const bike = bikeRow({ status: "maintenance", lockImei: "IMEI-1" });
    const selectResults: unknown[][] = [[bike], [lockRow({ lastLockState: null })]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: (v: unknown) => { setSpy(v); return chain; }, where: () => Promise.resolve() };
      return chain;
    });

    const result = await storage.adminUpdateBike("BC-01", { status: "available" });

    expect(result).toEqual({ error: expect.stringContaining("замок открыт") });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the lock has no registry row at all", async () => {
    const bike = bikeRow({ status: "maintenance", lockImei: "IMEI-1" });
    const selectResults: unknown[][] = [[bike], []];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: (v: unknown) => { setSpy(v); return chain; }, where: () => Promise.resolve() };
      return chain;
    });

    const result = await storage.adminUpdateBike("BC-01", { status: "available" });

    expect(result).toEqual({ error: expect.stringContaining("замок открыт") });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("allows the transition when the bike has no lock attached", async () => {
    const bike = bikeRow({ status: "maintenance", lockImei: null });
    const updated = bikeRow({ status: "available", lockImei: null, parkingId: "P-new" });
    // getBike(existing) -> listParkings' parkings select -> listParkings'
    // internal listBikes select -> recalculateBikeParking's updateBike ->
    // getBike (unused return) -> final adminUpdateBike getBike(workingId).
    const selectResults: unknown[][] = [[bike], [parkingRow()], [], [bike], [updated]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });

    const result = await storage.adminUpdateBike("BC-01", { status: "available" });

    expect(result).toEqual({ bike: updated });
  });

  it("checks the newly assigned lock, not the old one, when swapping locks in the same PATCH", async () => {
    const bike = bikeRow({ status: "maintenance", lockImei: "IMEI-OLD" });
    // The old lock would pass (locked), but the PATCH swaps to IMEI-NEW, whose
    // registry row has no reported state yet -> must fail closed on IMEI-NEW.
    const selectResults: unknown[][] = [[bike], [lockRow({ imei: "IMEI-NEW", lastLockState: null })]];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: (v: unknown) => { setSpy(v); return chain; }, where: () => Promise.resolve() };
      return chain;
    });

    const result = await storage.adminUpdateBike("BC-01", { status: "available", lockImei: "IMEI-NEW" });

    expect(result).toEqual({ error: expect.stringContaining("замок открыт") });
    expect(setSpy).not.toHaveBeenCalled();
  });
});

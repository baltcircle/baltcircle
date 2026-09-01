import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ride } from "@shared/schema";

// Audit HIGH #25: endRide previously had only one happy-path test. This file
// now also covers the no-op guards (missing/non-active ride), the no-overage
// settlement path, track-source fallback, and the emit/cache-invalidation
// side effects — all against a mocked tx/pool, no real DB.

// endRide now does a plain (pre-transaction) db.select() to look up the
// ride's funding payment order (see chargeRideOverageAsync in
// server/storage/ride.ts). Default to "no funding order found" so all
// pre-existing tests below keep exercising the legacy wallet-debit overage
// path unmodified; the dedicated overage-card-charge tests further down
// override this per-test.
function emptySelectChain() {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
  };
  return chain;
}
const dbMock = vi.hoisted(() => ({
  transaction: vi.fn(),
  select: vi.fn(),
}));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
const sendToUserAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: sendToUserAsyncMock }));

import { storage, rideEvents } from "./storage";
import { bikes } from "@shared/schema";
import { realToMap, RIDE_END_AWAITING_LOCK_GPS_ERROR, LOCK_GPS_LIVE_MS } from "@shared/geo";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = new Date("2026-08-11T12:00:00.000Z");

function makeRide(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 42,
    bikeId: "BC-01",
    userId: "user-1",
    startedAt: NOW.getTime() - HOUR - 1,
    endedAt: null,
    startLat: 1,
    startLng: 2,
    endLat: null,
    endLng: null,
    track: JSON.stringify([[2, 1, NOW.getTime() - HOUR - 1]]),
    distanceM: 0,
    cost: 35000,
    tariff: "h1",
    status: "active",
    ...overrides,
  } as Ride;
}

// Phase 2 (radius-gating): endRide now selects the bike row first to decide
// whether the lock-GPS hard block applies (bike.lockImei present) or the
// legacy phone-track fallback applies (no lock — the whole fleet in these
// pre-existing tests). lockImei defaults to null so these tests keep
// exercising the pre-Phase-2 behaviour unless a test opts in explicitly.
function makeBike(overrides: Record<string, unknown> = {}) {
  return { id: "BC-01", lockImei: null, ...overrides };
}

const IMEI = "861234567890123";
// Arbitrary real-WGS84 point (Kaliningrad area). makeParkingForRealPoint
// derives a matching map-space parking row from it, so tests that want the
// lock's fix to land inside a parking radius don't hand-compute coordinates.
const LOCK_REAL_LAT = 54.7;
const LOCK_REAL_LNG = 20.5;

function makeParkingForRealPoint(realLat: number, realLng: number, overrides: Record<string, unknown> = {}) {
  const { x, y } = realToMap(realLat, realLng);
  return {
    id: "P-1", lat: y, lng: x, radius: 30, status: "active", archivedAt: null,
    ...overrides,
  };
}

function makeLock(overrides: Record<string, unknown> = {}) {
  return {
    imei: IMEI, lastLatitude: LOCK_REAL_LAT, lastLongitude: LOCK_REAL_LNG,
    lastLocationAt: NOW.getTime(),
    ...overrides,
  };
}

// Detects the loadRidePoints() SELECT (audit HIGH #15 now runs it as
// `tx.execute(sql\`... FROM ride_points ...\`)` instead of a separate
// pool.query) so the tx mock can answer it distinctly from other execute()
// calls (the wallet UPSERT/decrement), without polluting `calls.execute` —
// that array's existing assertions count wallet-mutation side effects only.
function isRidePointsQuery(query: unknown): boolean {
  const chunks = (query as { queryChunks?: { value?: unknown[] }[] })?.queryChunks ?? [];
  return chunks.some((c) => Array.isArray(c?.value) && c.value.some((v) => typeof v === "string" && v.includes("ride_points")));
}

// Builds a tx mock whose select() calls resolve in order from `selectQueue`
// (rides row, bike row, parkings rows, optionally a locks row when the bike
// has a lockImei, final re-select of the completed ride) and records every
// update/insert/execute call for assertions. `ridePointsRows` answers the
// loadRidePoints() read specifically (see isRidePointsQuery).
function makeTx(selectQueue: unknown[][], ridePointsRows: { x: number; y: number; t: number }[] = []) {
  const calls = {
    update: [] as { table: unknown; patch: unknown }[],
    insert: [] as { table: unknown; values: unknown }[],
    execute: [] as unknown[],
    forCalled: false,
  };
  const queue = [...selectQueue];
  const tx: any = {
    select: vi.fn(() => {
      const rows = queue.shift() ?? [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        for: (mode: string) => {
          calls.forCalled = mode === "update";
          return chain;
        },
        limit: () => Promise.resolve(rows),
        then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    }),
    update: vi.fn((table: unknown) => {
      const chain: any = {
        set: (patch: unknown) => {
          calls.update.push({ table, patch });
          return chain;
        },
        where: () => Promise.resolve(),
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: (values: unknown) => {
        calls.insert.push({ table, values });
        return Promise.resolve();
      },
    })),
    execute: vi.fn((query: unknown) => {
      if (isRidePointsQuery(query)) return Promise.resolve({ rows: ridePointsRows });
      calls.execute.push(query);
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
  dbMock.select.mockImplementation(() => emptySelectChain());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("endRide — no-op guards", () => {
  it("returns undefined and never opens side effects when the ride does not exist", async () => {
    const { tx } = makeTx([[]]); // rides select finds nothing
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const emitSpy = vi.spyOn(rideEvents, "emit");
    const cacheSpy = vi.spyOn(storage, "invalidateBikesCache").mockImplementation(() => {});

    const result = await storage.endRide(999);

    expect(result).toBeUndefined();
    expect(tx.update).not.toHaveBeenCalled();
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
    expect(cacheSpy).not.toHaveBeenCalled();
  });

  it("returns undefined and does not re-settle a ride that is already completed (idempotent double-end)", async () => {
    const alreadyDone = makeRide({ status: "completed", endedAt: NOW.getTime() - 1000 });
    const { tx } = makeTx([[alreadyDone]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const emitSpy = vi.spyOn(rideEvents, "emit");

    const result = await storage.endRide(alreadyDone.id);

    expect(result).toBeUndefined();
    expect(tx.update).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("treats a cancelled ride the same as completed — no re-settlement", async () => {
    const cancelled = makeRide({ status: "cancelled" as Ride["status"] });
    const { tx } = makeTx([[cancelled]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(cancelled.id);

    expect(result).toBeUndefined();
    expect(tx.update).not.toHaveBeenCalled();
  });

  // Audit HIGH: two concurrent endRide(sameId) calls used to both read the
  // ride as "active" and both settle it (double overage charge / double
  // payment row). The fix locks the ride row with FOR UPDATE so the second
  // caller's SELECT blocks until the first transaction commits, then re-reads
  // status === "completed" and takes the no-op guard above. This test can't
  // simulate real lock contention against a mocked tx, but it pins the
  // concrete mechanism the fix relies on: the ride SELECT must actually
  // request the row lock, not just resolve some rows.
  it("requests a FOR UPDATE row lock on the ride before deciding whether to settle it", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike()], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    vi.setSystemTime(new Date(activeRide.startedAt + HOUR));

    await storage.endRide(activeRide.id);

    expect(calls.forCalled).toBe(true);
  });
});

describe("endRide — settlement without overage", () => {
  it("finishes within the paid window: no wallet debit, no payment row, no push", async () => {
    const activeRide = makeRide(); // started HOUR+1ms ago, h1 tariff = 1h paid
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike()], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    // Used time is just over the paid hour by 1ms -> rounds up to 1 overage
    // hour under the real computeOverage. To exercise the *no overage* branch
    // cleanly, end exactly at the paid boundary.
    vi.setSystemTime(new Date(activeRide.startedAt + HOUR));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual(completedRide);
    expect(calls.insert).toHaveLength(0); // no payments row
    expect(calls.execute).toHaveLength(0); // no wallet UPSERT/UPDATE
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });

  it("settles a ride on an unknown/legacy tariff without computing overage regardless of duration", async () => {
    const activeRide = makeRide({ tariff: "legacy-unknown", startedAt: NOW.getTime() - 5 * HOUR });
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed", tariff: "legacy-unknown" });
    const { tx, calls } = makeTx([[activeRide], [makeBike()], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.endRide(activeRide.id);

    expect(calls.execute).toHaveLength(0);
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });
});

describe("endRide — track source", () => {
  it("prefers the live ride_points rows over the legacy in-row track when both exist", async () => {
    const activeRide = makeRide({ track: JSON.stringify([[2, 1, NOW.getTime() - HOUR - 1]]) });
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike()], [], [completedRide]], [{ x: 10, y: 20, t: NOW.getTime() }]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.endRide(activeRide.id);

    const rideUpdate = calls.update.find((c) => c.patch && "endLat" in (c.patch as object));
    expect(rideUpdate).toBeDefined();
    expect((rideUpdate!.patch as any).endLat).toBe(20);
    expect((rideUpdate!.patch as any).endLng).toBe(10);
    expect((rideUpdate!.patch as any).track).toBe(JSON.stringify([[10, 20, NOW.getTime()]]));
  });

  it("falls back to the legacy in-row track when there are no ride_points rows", async () => {
    const activeRide = makeRide({ track: JSON.stringify([[5, 6, NOW.getTime() - HOUR - 1]]) });
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike()], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)); // no ride_points rows -> falls back to r.track

    await storage.endRide(activeRide.id);

    const rideUpdate = calls.update.find((c) => c.patch && "endLat" in (c.patch as object));
    expect((rideUpdate!.patch as any).endLat).toBe(6);
    expect((rideUpdate!.patch as any).endLng).toBe(5);
  });
});

describe("endRide — bike release and parking assignment", () => {
  it("frees the bike (status available) and clears parkingId when no active parking is within radius", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike()], [], [completedRide]]); // empty parkings list
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.endRide(activeRide.id);

    const bikeUpdates = calls.update.filter((c) => c.table === bikes);
    const statusUpdate = bikeUpdates.find((c) => c.patch && "status" in (c.patch as object));
    expect((statusUpdate!.patch as any).status).toBe("available");
    const parkingUpdate = bikeUpdates.find((c) => c.patch && "parkingId" in (c.patch as object));
    expect((parkingUpdate!.patch as any).parkingId).toBeNull();
  });
});

describe("endRide — auto-offline on low lock battery (rental spec addendum, 2026-09)", () => {
  it("lands the bike in \"offline\" (not \"available\") when the fresh battery reading is at/under the threshold", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike({ battery: 8 })], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const alertSpy = vi.spyOn(storage, "createLowBatteryOfflineAlert").mockResolvedValue(null);

    await storage.endRide(activeRide.id);

    const bikeUpdates = calls.update.filter((c) => c.table === bikes);
    const statusUpdate = bikeUpdates.find((c) => c.patch && "status" in (c.patch as object));
    expect((statusUpdate!.patch as any).status).toBe("offline");
    expect((statusUpdate!.patch as any).maintenanceReason).toBe("auto:low_battery");
    expect(alertSpy).toHaveBeenCalledWith("BC-01", 8, expect.any(Number));
  });

  it("still frees the bike to \"available\" when the fresh battery reading is above the threshold", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike({ battery: 45 })], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const alertSpy = vi.spyOn(storage, "createLowBatteryOfflineAlert").mockResolvedValue(null);

    await storage.endRide(activeRide.id);

    const bikeUpdates = calls.update.filter((c) => c.table === bikes);
    const statusUpdate = bikeUpdates.find((c) => c.patch && "status" in (c.patch as object));
    expect((statusUpdate!.patch as any).status).toBe("available");
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe("endRide — side effects only fire on real settlement", () => {
  it("invalidates the bikes cache and emits a rider 'end' event when the ride settles", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx } = makeTx([[activeRide], [makeBike()], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    const emitSpy = vi.spyOn(rideEvents, "emit");
    const cacheSpy = vi.spyOn(storage, "invalidateBikesCache").mockImplementation(() => {});

    await storage.endRide(activeRide.id);

    expect(cacheSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith(completedRide.userId, "end");
  });
});

describe("endRide charge confirmation push", () => {
  it("confirms the successful ride-end overage amount to the rider", async () => {
    // h1 tariff pays 1h; ride ran exactly 1h1m -> one COMPLETED overage
    // minute billed (per-completed-minute model — a few ms over the paid
    // window with no full minute elapsed yet would charge nothing).
    const activeRide = makeRide({ startedAt: NOW.getTime() - HOUR - MINUTE });
    const completedRide = makeRide({ endedAt: NOW.getTime(), cost: 70000, status: "completed" });
    // Wallet debit for the overage is now a raw tx.execute(sql`UPDATE ...`)
    // (audit CRITICAL #5 — atomic decrement, no SELECT-then-UPDATE round trip),
    // so it no longer shows up as a tx.select()/tx.update() call here.
    const { tx } = makeTx([[activeRide], [makeBike()], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.endRide(activeRide.id);

    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", {
      title: "Оплата поездки",
      body: "Списано 12 ₽ за поездку. Спасибо, что пользуетесь TakeRide!",
      url: "/rides",
      tag: "ride:42:overage",
      data: { kind: "ride-charge-confirmed", rideId: 42 },
    });
  });

  it("charges one overage minute per completed extra minute beyond the paid window", async () => {
    // h1 tariff pays 1h; ride ran 2h30m total -> 1h30m (90min) over the paid
    // window, all whole minutes so no rounding kicks in.
    const activeRide = makeRide({ startedAt: NOW.getTime() - 2.5 * HOUR });
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike()], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.endRide(activeRide.id);

    expect(calls.insert).toHaveLength(1);
    expect((calls.insert[0].values as any).description).toContain("+90 мин");
    expect(calls.execute).toHaveLength(2); // wallet UPSERT + balance decrement
  });

  // Routing fix: when the ride was funded by a real card/SBP order (not the
  // wallet), the overage must be charged the SAME way — the legacy wallet
  // debit is now gated on `!fundingOrder` and must NOT fire in that case,
  // even though overageKopecks > 0. See chargeRideOverageAsync's own
  // dedicated test suite (server/storage.ride-overage.test.ts) for the full
  // card-charge behaviour; this test only pins endRide's routing decision.
  it("skips the wallet debit entirely when the ride was funded by a card/SBP order (routes to the card-charge path instead)", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), cost: 70000, status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [makeBike()], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    // First db.select() (pre-transaction) = getLatestPaidRidePaymentOrder ->
    // a real funding order; every subsequent db.select() (e.g. the card
    // charge's own getPaymentMethod lookup) falls back to the generic empty
    // chain configured in beforeEach.
    dbMock.select.mockImplementationOnce(() => {
      const chain: any = {
        from: () => chain, where: () => chain, orderBy: () => chain,
        limit: () => Promise.resolve([{ id: 900, paymentMethodId: 5, source: "saved_card" }]),
      };
      return chain;
    });

    await storage.endRide(activeRide.id);
    // Let the fire-and-forget chargeRideOverageAsync's microtask chain settle
    // (it has no real payment method behind id 5 here, so it fails fast and
    // safely via its own .catch(() => {})-guarded alert path).
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(calls.execute).toHaveLength(0); // no wallet UPSERT/decrement
    expect(calls.insert).toHaveLength(0); // no wallet ride_charge ledger row
  });
});

// Production incident, 2026-08-27: this hard-block (commit 78eeeeb) had ZERO
// test coverage before this fix — added alongside the settle-with-retry fix
// in server/storage.ts so the gate's exact behaviour (and its exact error
// string, which the retry loop matches on) is pinned going forward.
describe("endRide — lock-equipped bike GPS/radius gate", () => {
  it("blocks with the awaiting-GPS error when the lock has never reported a fix", async () => {
    const activeRide = makeRide();
    const bike = makeBike({ lockImei: IMEI });
    const { tx } = makeTx([[activeRide], [bike], [], []]); // locks select returns no row
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual({ error: RIDE_END_AWAITING_LOCK_GPS_ERROR });
    expect(tx.update).not.toHaveBeenCalled(); // no partial settlement — ride stays active
  });

  it("blocks with the awaiting-GPS error when the lock's last fix is older than LOCK_GPS_LIVE_MS", async () => {
    const activeRide = makeRide();
    const bike = makeBike({ lockImei: IMEI });
    const staleLock = makeLock({ lastLocationAt: NOW.getTime() - LOCK_GPS_LIVE_MS - 1 });
    const { tx } = makeTx([[activeRide], [bike], [], [staleLock]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual({ error: RIDE_END_AWAITING_LOCK_GPS_ERROR });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("blocks with a distinct, non-retryable error when the fresh fix is outside any parking radius", async () => {
    const activeRide = makeRide();
    const bike = makeBike({ lockImei: IMEI });
    const freshLock = makeLock();
    // Parking far from the lock's real point -> no radius match.
    const farParking = makeParkingForRealPoint(LOCK_REAL_LAT + 5, LOCK_REAL_LNG + 5);
    const { tx } = makeTx([[activeRide], [bike], [farParking], [freshLock]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual({ error: expect.stringContaining("не в зоне парковки") });
    expect((result as { error: string }).error).not.toBe(RIDE_END_AWAITING_LOCK_GPS_ERROR);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("settles successfully using the lock's own fix when fresh and inside a parking radius", async () => {
    const activeRide = makeRide();
    const bike = makeBike({ lockImei: IMEI });
    const freshLock = makeLock();
    const parking = makeParkingForRealPoint(LOCK_REAL_LAT, LOCK_REAL_LNG);
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [bike], [parking], [freshLock], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual(completedRide);
    const bikeUpdate = calls.update.find((c) => c.table === bikes);
    expect((bikeUpdate!.patch as any).parkingId).toBe("P-1");
  });

  it("bypasses the gate entirely for a lockless (legacy) bike", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx } = makeTx([[activeRide], [makeBike()], [], [completedRide]]); // no locks select in the queue
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual(completedRide);
  });

  it("bypasses the gate when the caller explicitly requests skipGeofence (admin force-end)", async () => {
    const activeRide = makeRide();
    const bike = makeBike({ lockImei: IMEI });
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    // No locks select in the queue — skipGeofence must short-circuit before it.
    const { tx } = makeTx([[activeRide], [bike], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id, { skipGeofence: true });

    expect(result).toEqual(completedRide);
  });
});

// GPS-accuracy item 4: median-of-recent-fixes smoothing for the geofence
// decision specifically. These pin the tx.execute(sql`... FROM
// bike_telemetry ...`) query's result being used in place of the single
// locks.last_* point when telemetry has enough recent, hdop-acceptable rows.
describe("endRide — lock-equipped bike geofence smoothing (GPS accuracy item 4)", () => {
  function makeTxWithTelemetry(selectQueue: unknown[][], telemetryRows: { lat: number; lng: number; t: number }[]) {
    const { tx, calls } = makeTx(selectQueue);
    const originalExecute = tx.execute.getMockImplementation()!;
    tx.execute.mockImplementation((query: unknown) => {
      const chunks = (query as { queryChunks?: { value?: unknown[] }[] })?.queryChunks ?? [];
      const isTelemetryQuery = chunks.some(
        (c) => Array.isArray(c?.value) && c.value.some((v) => typeof v === "string" && v.includes("bike_telemetry")),
      );
      if (isTelemetryQuery) return Promise.resolve({ rows: telemetryRows });
      return originalExecute(query);
    });
    return { tx, calls };
  }

  it("settles using the per-axis median of recent telemetry fixes instead of the single last point", async () => {
    const activeRide = makeRide();
    const bike = makeBike({ lockImei: IMEI });
    // locks.last_* deliberately way off — if the median query's result were
    // ignored, the parking match / final coords would come from here instead.
    const staleLooking = makeLock({ lastLatitude: LOCK_REAL_LAT + 5, lastLongitude: LOCK_REAL_LNG + 5 });
    const parking = makeParkingForRealPoint(LOCK_REAL_LAT, LOCK_REAL_LNG);
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    // Median of [LAT, LAT, LAT+0.01] on both axes lands on LAT/LNG — inside
    // the parking radius built around the plain LOCK_REAL_LAT/LNG point.
    const telemetryRows = [
      { lat: LOCK_REAL_LAT, lng: LOCK_REAL_LNG, t: NOW.getTime() },
      { lat: LOCK_REAL_LAT, lng: LOCK_REAL_LNG, t: NOW.getTime() - 10_000 },
      { lat: LOCK_REAL_LAT + 0.01, lng: LOCK_REAL_LNG + 0.01, t: NOW.getTime() - 20_000 },
    ];
    const { tx } = makeTxWithTelemetry([[activeRide], [bike], [parking], [staleLooking], [completedRide]], telemetryRows);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual(completedRide);
  });

  it("falls back to the single locks.last_* point when telemetry has no recent hdop-acceptable rows", async () => {
    const activeRide = makeRide();
    const bike = makeBike({ lockImei: IMEI });
    const freshLock = makeLock();
    const parking = makeParkingForRealPoint(LOCK_REAL_LAT, LOCK_REAL_LNG);
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx } = makeTxWithTelemetry([[activeRide], [bike], [parking], [freshLock], [completedRide]], []);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual(completedRide);
  });

  it("still blocks with the awaiting-GPS error when neither telemetry nor locks has a fresh point", async () => {
    const activeRide = makeRide();
    const bike = makeBike({ lockImei: IMEI });
    const staleLock = makeLock({ lastLocationAt: NOW.getTime() - LOCK_GPS_LIVE_MS - 1 });
    const { tx } = makeTxWithTelemetry([[activeRide], [bike], [], [staleLock]], []);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    const result = await storage.endRide(activeRide.id);

    expect(result).toEqual({ error: RIDE_END_AWAITING_LOCK_GPS_ERROR });
    expect(tx.update).not.toHaveBeenCalled();
  });
});

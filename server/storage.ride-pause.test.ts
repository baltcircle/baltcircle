// Tests for the pause/resume/extend storage methods (active-ride redesign):
// requestPauseRide (arm-only, gated on OMNI lock closure for locked bikes,
// immediate for legacy no-lock bikes), resumeRide (immediate, also cancels a
// still-pending arm), extendRide (always available, additive to paidUntilAt).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike, Ride } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn(), update: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
const getLockGatewayMock = vi.hoisted(() => vi.fn());
const registerPendingPauseMock = vi.hoisted(() => vi.fn());
const clearPendingPauseMock = vi.hoisted(() => vi.fn());

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./omni/gateway", () => ({ getLockGateway: getLockGatewayMock }));
vi.mock("./omni/pause-registry", () => ({
  registerPendingPause: registerPendingPauseMock,
  clearPendingPause: clearPendingPauseMock,
  hasPendingPause: vi.fn(),
  consumePendingPause: vi.fn(),
}));

import { storage } from "./storage";

const NOW = new Date("2026-08-21T12:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;

function makeBike(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "Cruiser", status: "in_use", battery: 80,
    lat: 1, lng: 2, lastSeen: NOW, idleHours: 0, flagged: false,
    parkingId: null,
    lockImei: null, lockOnline: false, lockLastSeen: null,
    notes: null, seed: false,
    ...overrides,
  } as Bike;
}

function makeRide(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 7, bikeId: "BC-01", userId: "user-1", startedAt: NOW - HOUR, endedAt: null,
    startLat: 1, startLng: 2, endLat: null, endLng: null,
    track: JSON.stringify([[2, 1, NOW]]), distanceM: 0,
    cost: 35000, tariff: "h1", status: "active", physicallyLockedAt: null,
    paidUntilAt: NOW - HOUR + HOUR, pausedAt: null, totalPausedMs: 0,
    totalTariffHours: 1,
    ...overrides,
  } as Ride;
}

// db.select() outside a transaction (used by requestPauseRide's own lookups
// and by resumeRide's `this.getBike` best-effort call after its transaction).
function queueSelect(rows: unknown[]) {
  dbMock.select.mockImplementationOnce(() => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return chain;
  });
}

// db.update() outside a transaction — only requestPauseRide's legacy
// (no-lock) immediate-pause branch uses this.
function queueUpdateReturning(rows: unknown[]) {
  dbMock.update.mockImplementationOnce(() => ({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve(rows),
      }),
    }),
  }));
}

// tx.select() consumed in order, mirroring storage.ride-unlock.test.ts's convention.
function makeTx(selectQueue: unknown[][]) {
  const calls = { updateSets: [] as unknown[], insertValues: [] as unknown[], execute: [] as unknown[] };
  const tx: any = {
    select: vi.fn(() => {
      const rows = selectQueue.shift() ?? [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        for: () => chain,
        limit: () => Promise.resolve(rows),
      };
      return chain;
    }),
    update: vi.fn(() => ({
      set: (values: unknown) => {
        calls.updateSets.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...makeRide(), ...(values as object) }]),
          }),
        };
      },
    })),
    insert: vi.fn(() => ({
      values: (values: any) => {
        calls.insertValues.push(values);
        return Promise.resolve();
      },
    })),
    execute: vi.fn((query: any) => {
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
  getLockGatewayMock.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requestPauseRide", () => {
  it("pauses immediately for a legacy bike with no smart lock", async () => {
    queueSelect([makeRide({ pausedAt: null })]);
    queueSelect([makeBike({ lockImei: null })]);
    queueUpdateReturning([makeRide({ pausedAt: NOW })]);

    const result = await storage.requestPauseRide(7);

    expect(result).toMatchObject({ status: "paused" });
    expect(registerPendingPauseMock).not.toHaveBeenCalled();
  });

  it("only arms the pause for a bike with a bound lock, without setting pausedAt", async () => {
    queueSelect([makeRide({ pausedAt: null })]);
    queueSelect([makeBike({ lockImei: "868000000000001" })]);

    const result = await storage.requestPauseRide(7);

    expect(result).toMatchObject({ status: "awaiting_lock_close" });
    expect(registerPendingPauseMock).toHaveBeenCalledWith("868000000000001", 7, "user-1", expect.any(Number));
  });

  it("rejects pausing a ride that is already paused", async () => {
    queueSelect([makeRide({ pausedAt: NOW - 1000 })]);

    const result = await storage.requestPauseRide(7);

    expect(result).toHaveProperty("error");
    expect(registerPendingPauseMock).not.toHaveBeenCalled();
  });

  it("rejects pausing a non-active ride", async () => {
    queueSelect([makeRide({ status: "completed" })]);

    const result = await storage.requestPauseRide(7);

    expect(result).toHaveProperty("error");
  });
});

describe("resumeRide", () => {
  it("cancels a still-pending (not-yet-confirmed) pause without erroring", async () => {
    const active = makeRide({ pausedAt: null });
    const { tx } = makeTx([[active]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    queueSelect([makeBike({ lockImei: "868000000000001" })]); // this.getBike

    const result = await storage.resumeRide(7);

    expect(result).not.toHaveProperty("error");
    expect(clearPendingPauseMock).toHaveBeenCalledWith("868000000000001");
  });

  it("credits paidUntilAt by the pending pause duration within the free grace", async () => {
    const pausedAt = NOW - 3 * 60 * 1000; // paused 3 min ago
    const paused = makeRide({ pausedAt, totalPausedMs: 0 });
    const { tx, calls } = makeTx([[paused]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    queueSelect([makeBike({ lockImei: "868000000000001" })]);
    getLockGatewayMock.mockReturnValue({ sendToDevice: vi.fn().mockReturnValue(true) });

    const result = await storage.resumeRide(7);

    expect(result).not.toHaveProperty("error");
    const set = calls.updateSets[0] as any;
    expect(set.pausedAt).toBeNull();
    // 3 minutes fully inside the 10-minute cumulative grace -> full credit.
    expect(set.paidUntilAt).toBe(paused.paidUntilAt! + 3 * 60 * 1000);
    expect(set.totalPausedMs).toBe(3 * 60 * 1000);
  });

  // Regression test for the 2026-08-24 bug: resume used to send "D1" (the
  // GPS-tracking-enable command) instead of the real L0 unlock, so the ride's
  // billing/timer state advanced but the physical lock never reopened.
  it("physically unlocks via sendUnlockCommand (not sendToDevice/D1) when resuming a locked bike", async () => {
    const pausedAt = NOW - 3 * 60 * 1000;
    const paused = makeRide({ pausedAt, totalPausedMs: 0 });
    const { tx } = makeTx([[paused]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    queueSelect([makeBike({ lockImei: "868000000000001" })]);
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    const sendToDevice = vi.fn().mockReturnValue(true);
    getLockGatewayMock.mockReturnValue({ sendUnlockCommand, sendToDevice });

    const result = await storage.resumeRide(7);

    expect(result).not.toHaveProperty("error");
    expect(sendUnlockCommand).toHaveBeenCalledWith("868000000000001", 7);
    // D1 (GPS tracking) must NOT be re-sent on resume — it was never turned
    // off by pause in the first place (only endRide disables it).
    expect(sendToDevice).not.toHaveBeenCalled();
  });

  it("still resumes (best-effort) when the physical unlock fails or the gateway is down", async () => {
    const pausedAt = NOW - 3 * 60 * 1000;
    const paused = makeRide({ pausedAt, totalPausedMs: 0 });
    const { tx, calls } = makeTx([[paused]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    queueSelect([makeBike({ lockImei: "868000000000001" })]);
    getLockGatewayMock.mockReturnValue({
      sendUnlockCommand: vi.fn().mockRejectedValue(new Error("lock is not connected")),
    });

    const result = await storage.resumeRide(7);

    expect(result).not.toHaveProperty("error");
    const set = calls.updateSets[0] as any;
    expect(set.pausedAt).toBeNull();
  });

  it("caps the credit at the remaining cumulative free grace", async () => {
    const pausedAt = NOW - 5 * 60 * 1000; // paused 5 min ago
    // Only 2 minutes of grace remain (10-minute cumulative budget - 8 already used).
    const paused = makeRide({ pausedAt, totalPausedMs: 8 * 60 * 1000 });
    const { tx, calls } = makeTx([[paused]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    queueSelect([makeBike({ lockImei: null })]);

    const result = await storage.resumeRide(7);

    expect(result).not.toHaveProperty("error");
    const set = calls.updateSets[0] as any;
    expect(set.paidUntilAt).toBe(paused.paidUntilAt! + 2 * 60 * 1000);
    expect(set.totalPausedMs).toBe(8 * 60 * 1000 + 5 * 60 * 1000);
  });

  it("rejects resuming a non-active ride", async () => {
    const { tx } = makeTx([[makeRide({ status: "completed" })]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.resumeRide(7);

    expect(result).toHaveProperty("error");
  });

  // Regression test for the lock-close-during-active-ride deadlock fix:
  // server/omni/store.ts's lockReport handler auto-pauses AND sets
  // physicallyLockedAt together when the rider closes the lock without
  // tapping "Пауза". If resume left that flag set, a later "Завершить" tap
  // would wrongly fast-path straight to endRide() via requestEndRide's
  // physicallyLockedAt check, without ever confirming a fresh physical
  // closure (the lock reopens right here, on this resume).
  it("clears a stale physicallyLockedAt (set by an earlier auto-pause) on real resume", async () => {
    const pausedAt = NOW - 3 * 60 * 1000;
    const paused = makeRide({ pausedAt, totalPausedMs: 0, physicallyLockedAt: pausedAt });
    const { tx, calls } = makeTx([[paused]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));
    queueSelect([makeBike({ lockImei: "868000000000001" })]);
    getLockGatewayMock.mockReturnValue({ sendUnlockCommand: vi.fn().mockResolvedValue({ success: true }) });

    const result = await storage.resumeRide(7);

    expect(result).not.toHaveProperty("error");
    const set = calls.updateSets[0] as any;
    expect(set.pausedAt).toBeNull();
    expect(set.physicallyLockedAt).toBeNull();
  });
});

// Regression tests for requestEndRide's fast-path gating ("Завершить" tapped
// while the ride is already paused). These isolate the gating decision from
// the full endRide() transaction by calling requestEndRide with a stubbed
// `this` — requestEndRide's own module-level db.select() calls still go
// through dbMock, but the only thing under test is whether it calls the
// stubbed endRide() directly vs. arms a pending end.
function makeEndRideThis() {
  return {
    endRide: vi.fn().mockResolvedValue(makeRide({ status: "completed" })),
    invalidateBikesCache: vi.fn(),
    loadRidePoints: vi.fn().mockResolvedValue([]),
  };
}

describe("requestEndRide", () => {
  it("fast-paths straight to endRide() when the ride is already paused on a smart-lock bike", async () => {
    queueSelect([makeRide({ pausedAt: NOW - 60000, physicallyLockedAt: null })]);
    queueSelect([makeBike({ lockImei: "868000000000001" })]);
    const fakeThis = makeEndRideThis();

    const result = await storage.requestEndRide.call(fakeThis, 7);

    expect(fakeThis.endRide).toHaveBeenCalledWith(7);
    expect(registerPendingPauseMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "completed" });
  });

  it("still arms and waits for a smart-lock bike that is active and not paused/confirmed-closed", async () => {
    queueSelect([makeRide({ pausedAt: null, physicallyLockedAt: null })]);
    queueSelect([makeBike({ lockImei: "868000000000001" })]);
    const fakeThis = makeEndRideThis();

    const result = await storage.requestEndRide.call(fakeThis, 7);

    expect(fakeThis.endRide).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "awaiting_lock_close" });
  });

  it("still fast-paths via the pre-existing physicallyLockedAt flag (not paused, but previously confirmed closed)", async () => {
    queueSelect([makeRide({ pausedAt: null, physicallyLockedAt: NOW - 60000 })]);
    queueSelect([makeBike({ lockImei: "868000000000001" })]);
    const fakeThis = makeEndRideThis();

    const result = await storage.requestEndRide.call(fakeThis, 7);

    expect(fakeThis.endRide).toHaveBeenCalledWith(7);
    expect(result).toMatchObject({ status: "completed" });
  });

  it("always fast-paths a legacy bike with no smart lock, paused or not", async () => {
    queueSelect([makeRide({ pausedAt: NOW - 60000 })]);
    queueSelect([makeBike({ lockImei: null })]);
    const fakeThis = makeEndRideThis();

    const result = await storage.requestEndRide.call(fakeThis, 7);

    expect(fakeThis.endRide).toHaveBeenCalledWith(7);
    expect(result).toMatchObject({ status: "completed" });
  });

  it("rejects ending a non-active ride", async () => {
    queueSelect([makeRide({ status: "completed" })]);
    const fakeThis = makeEndRideThis();

    const result = await storage.requestEndRide.call(fakeThis, 7);

    expect(result).toHaveProperty("error");
    expect(fakeThis.endRide).not.toHaveBeenCalled();
  });
});

describe("extendRide", () => {
  it("debits the wallet and pushes paidUntilAt back by the tariff's duration, additively", async () => {
    const active = makeRide({ paidUntilAt: NOW + 10 * 60 * 1000 });
    const { tx, calls } = makeTx([[active]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.extendRide(7, "h1");

    expect(result).not.toHaveProperty("error");
    expect(calls.execute.some((q) => String(q).includes("UPDATE wallet") && String(q).includes("balance -"))).toBe(true);
    const set = calls.updateSets[0] as any;
    expect(set.paidUntilAt).toBe(active.paidUntilAt! + HOUR); // h1 = 1 hour
    expect(calls.insertValues.some((v: any) => v?.kind === "ride_charge" && v.amount < 0)).toBe(true);
  });

  // Bug fix: extending a ride previously left `cost`/tariff display at the
  // ORIGINAL tariff only (paidUntilAt moved, but nothing else did), so an h1
  // ride extended by another h1 showed "1 час / 350₽" in history/dashboard
  // instead of "2 часа / 700₽". extendRide must now accumulate both fields.
  it("accumulates cost and totalTariffHours on top of the ride's existing values, not just paidUntilAt", async () => {
    const active = makeRide({ cost: 35000, totalTariffHours: 1, paidUntilAt: NOW + 10 * 60 * 1000 });
    const { tx, calls } = makeTx([[active]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.extendRide(7, "h1");

    expect(result).not.toHaveProperty("error");
    const set = calls.updateSets[0] as any;
    expect(set.cost).toBe(70000); // 350₽ + 350₽ = 700₽, in kopecks
    expect(set.totalTariffHours).toBe(2); // 1h + 1h
  });

  it("accumulates a THIRD hour correctly (h1 -> extend h2 -> 3 hours total)", async () => {
    const active = makeRide({ cost: 35000, totalTariffHours: 1, paidUntilAt: NOW + 10 * 60 * 1000 });
    const { tx, calls } = makeTx([[active]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.extendRide(7, "h2");

    expect(result).not.toHaveProperty("error");
    const set = calls.updateSets[0] as any;
    expect(set.totalTariffHours).toBe(3); // 1h (original) + 2h (h2 extension)
  });

  it("works while the ride is paused (no pausedAt gating)", async () => {
    const paused = makeRide({ pausedAt: NOW - 60000 });
    const { tx } = makeTx([[paused]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.extendRide(7, "h2");

    expect(result).not.toHaveProperty("error");
  });

  it("fails without debiting when the wallet balance is insufficient", async () => {
    const active = makeRide();
    const { tx, calls } = makeTx([[active]]);
    tx.execute = vi.fn(() => Promise.resolve({ rows: [] })); // debit finds no row -> insufficient funds
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.extendRide(7, "h1");

    expect(result).toHaveProperty("error");
    expect(calls.insertValues.length).toBe(0);
  });

  it("rejects an unknown tariff", async () => {
    const result = await storage.extendRide(7, "bogus");
    expect(result).toHaveProperty("error");
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});

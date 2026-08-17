import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ride } from "@shared/schema";

// Audit HIGH #25: endRide previously had only one happy-path test. This file
// now also covers the no-op guards (missing/non-active ride), the no-overage
// settlement path, track-source fallback, and the emit/cache-invalidation
// side effects — all against a mocked tx/pool, no real DB.

const dbMock = vi.hoisted(() => ({
  transaction: vi.fn(),
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

const HOUR = 60 * 60 * 1000;
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

// Builds a tx mock whose select() calls resolve in order from `selectQueue`
// (rides row, parkings rows, final re-select of the completed ride) and
// records every update/insert/execute call for assertions.
function makeTx(selectQueue: unknown[][]) {
  const calls = {
    update: [] as { table: unknown; patch: unknown }[],
    insert: [] as { table: unknown; values: unknown }[],
    execute: [] as unknown[],
  };
  const queue = [...selectQueue];
  const tx: any = {
    select: vi.fn(() => {
      const rows = queue.shift() ?? [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
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
});

describe("endRide — settlement without overage", () => {
  it("finishes within the paid window: no wallet debit, no payment row, no push", async () => {
    const activeRide = makeRide(); // started HOUR+1ms ago, h1 tariff = 1h paid
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [], [completedRide]]);
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
    const { tx, calls } = makeTx([[activeRide], [], [completedRide]]);
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
    const { tx, calls } = makeTx([[activeRide], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    poolMock.query.mockResolvedValue({ rows: [{ x: 10, y: 20, t: NOW.getTime() }] });

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
    const { tx, calls } = makeTx([[activeRide], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
    poolMock.query.mockResolvedValue({ rows: [] }); // no ride_points

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
    const { tx, calls } = makeTx([[activeRide], [], [completedRide]]); // empty parkings list
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.endRide(activeRide.id);

    const bikeUpdates = calls.update.filter((c) => c.table === bikes);
    const statusUpdate = bikeUpdates.find((c) => c.patch && "status" in (c.patch as object));
    expect((statusUpdate!.patch as any).status).toBe("available");
    const parkingUpdate = bikeUpdates.find((c) => c.patch && "parkingId" in (c.patch as object));
    expect((parkingUpdate!.patch as any).parkingId).toBeNull();
  });
});

describe("endRide — side effects only fire on real settlement", () => {
  it("invalidates the bikes cache and emits a rider 'end' event when the ride settles", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx } = makeTx([[activeRide], [], [completedRide]]);
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
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), cost: 70000, status: "completed" });
    // Wallet debit for the overage is now a raw tx.execute(sql`UPDATE ...`)
    // (audit CRITICAL #5 — atomic decrement, no SELECT-then-UPDATE round trip),
    // so it no longer shows up as a tx.select()/tx.update() call here.
    const { tx } = makeTx([[activeRide], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.endRide(activeRide.id);

    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", {
      title: "Оплата поездки",
      body: "Списано 350 ₽ за поездку. Спасибо, что пользуетесь TakeRide!",
      url: "/rides",
      tag: "ride:42:overage",
      data: { kind: "ride-charge-confirmed", rideId: 42 },
    });
  });

  it("charges one overage hour per started extra hour beyond the paid window", async () => {
    // h1 tariff pays 1h; ride ran 2h30m total -> 1h30m over the paid window,
    // which rounds up to 2 started extra hours.
    const activeRide = makeRide({ startedAt: NOW.getTime() - 2.5 * HOUR });
    const completedRide = makeRide({ endedAt: NOW.getTime(), status: "completed" });
    const { tx, calls } = makeTx([[activeRide], [], [completedRide]]);
    dbMock.transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

    await storage.endRide(activeRide.id);

    expect(calls.insert).toHaveLength(1);
    expect((calls.insert[0].values as any).description).toContain("+2 ч");
    expect(calls.execute).toHaveLength(2); // wallet UPSERT + balance decrement
  });
});

// Tests for the reservation ("Бронь") feature added to RentalStartModal:
// storage.createReservation/cancelReservation/expireOverdueReservations and
// the ownership gate that lets startRide (ride.ts) claim a reservation are
// covered here; the claim itself is exercised in storage.ride-unlock.test.ts's
// sibling file for startRide, so this file focuses on reservation.ts alone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike, Reservation } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));

import { storage } from "./storage";

const NOW = new Date("2026-08-21T12:00:00.000Z");

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

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 1, bikeId: "BC-01", userId: "user-1",
    createdAt: NOW.getTime(), expiresAt: NOW.getTime() + 10 * 60 * 1000,
    status: "active", claimedRideId: null,
    ...overrides,
  } as Reservation;
}

// Same generic tx builder as storage.ride-unlock.test.ts: `selectQueue` feeds
// consecutive `tx.select()...` chains in call order; `executeResponses` feeds
// consecutive `tx.execute(sql...)` calls in call order (defaults to empty rows).
function makeTx(selectQueue: unknown[][], executeResponses: unknown[] = []) {
  const calls = { execute: [] as string[], updateSets: [] as any[], insertValues: [] as any[] };
  let execIdx = 0;
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
      set: (values: any) => {
        calls.updateSets.push(values);
        return { where: () => Promise.resolve() };
      },
    })),
    insert: vi.fn(() => ({
      values: (values: any) => {
        calls.insertValues.push(values);
        return { returning: () => Promise.resolve([{ id: 1, ...values }]) };
      },
    })),
    execute: vi.fn((query: any) => {
      const sqlText = typeof query?.toQuery === "function"
        ? query.toQuery({ escapeParam: (i: number) => "$" + i }).sql
        : String(query);
      calls.execute.push(sqlText);
      const resp = execIdx < executeResponses.length ? executeResponses[execIdx] : { rows: [] };
      execIdx++;
      return Promise.resolve(resp);
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

describe("storage.createReservation", () => {
  it("creates a reservation and flips the bike to reserved when it's available and the rider is free", async () => {
    const bike = makeBike({ status: "available" });
    // select order: [bike FOR UPDATE], [existingForUser active reservation]
    const { tx, calls } = makeTx([[bike], []], [{ rows: [] } /* no active ride */]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.createReservation({ bikeId: "BC-01", userId: "user-1" });

    expect(result).not.toHaveProperty("error");
    expect(calls.insertValues[0]).toMatchObject({ bikeId: "BC-01", userId: "user-1", status: "active" });
    expect(calls.updateSets.some((v) => v.status === "reserved")).toBe(true);
  });

  it("rejects when the bike is not available", async () => {
    const bike = makeBike({ status: "rented" });
    const { tx } = makeTx([[bike]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.createReservation({ bikeId: "BC-01", userId: "user-1" });

    expect(result).toHaveProperty("error");
  });

  it("rejects a second reservation for a rider who already holds one (any bike)", async () => {
    const bike = makeBike({ status: "available" });
    const existing = makeReservation({ bikeId: "BC-02" });
    const { tx } = makeTx([[bike], [existing]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.createReservation({ bikeId: "BC-01", userId: "user-1" });

    expect(result).toMatchObject({ error: expect.stringContaining("активная бронь") });
  });

  it("rejects a reservation for a rider who already has an active ride", async () => {
    const bike = makeBike({ status: "available" });
    const { tx } = makeTx([[bike], []], [{ rows: [{ id: 99 }] } /* active ride exists */]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.createReservation({ bikeId: "BC-01", userId: "user-1" });

    expect(result).toMatchObject({ error: expect.stringContaining("активная поездка") });
  });

  it("translates a unique-violation race into a friendly error instead of throwing", async () => {
    dbMock.transaction.mockRejectedValue({ code: "23505" });

    const result = await storage.createReservation({ bikeId: "BC-01", userId: "user-1" });

    expect(result).toMatchObject({ error: expect.stringContaining("уже забронирован") });
  });
});

describe("storage.cancelReservation", () => {
  it("cancels the caller's own active reservation and frees the bike", async () => {
    const row = makeReservation();
    const { tx, calls } = makeTx([[row]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.cancelReservation(1, "user-1");

    expect(result).toEqual({ ok: true });
    expect(calls.updateSets.some((v) => v.status === "cancelled")).toBe(true);
    expect(calls.updateSets.some((v) => v.status === "available")).toBe(true);
  });

  it("rejects cancelling someone else's reservation", async () => {
    const row = makeReservation({ userId: "user-2" });
    const { tx } = makeTx([[row]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.cancelReservation(1, "user-1");

    expect(result).toMatchObject({ error: expect.stringContaining("не ваша бронь") });
  });

  it("rejects cancelling a reservation that is already claimed/expired/cancelled", async () => {
    const row = makeReservation({ status: "claimed" });
    const { tx } = makeTx([[row]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.cancelReservation(1, "user-1");

    expect(result).toMatchObject({ error: expect.stringContaining("неактивна") });
  });

  it("returns a not-found error for a nonexistent reservation id", async () => {
    const { tx } = makeTx([[]]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const result = await storage.cancelReservation(999, "user-1");

    expect(result).toMatchObject({ error: expect.stringContaining("не найдена") });
  });
});

describe("storage.expireOverdueReservations", () => {
  it("flips overdue active reservations to expired and frees their bikes", async () => {
    const { tx, calls } = makeTx([], [
      { rows: [{ id: 1, bike_id: "BC-01" }, { id: 2, bike_id: "BC-02" }] }, // overdue SELECT
      { rows: [] }, // UPDATE reservations
      { rows: [] }, // UPDATE bikes for BC-01
      { rows: [] }, // UPDATE bikes for BC-02
    ]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const count = await storage.expireOverdueReservations();

    expect(count).toBe(2);
    expect(calls.execute.some((q) => q.includes("UPDATE reservations SET status = 'expired'"))).toBe(true);
    expect(calls.execute.filter((q) => q.includes("UPDATE bikes SET status = 'available'")).length).toBe(2);
  });

  it("is a no-op when nothing is overdue", async () => {
    const { tx, calls } = makeTx([], [{ rows: [] }]);
    dbMock.transaction.mockImplementation(async (cb: any) => cb(tx));

    const count = await storage.expireOverdueReservations();

    expect(count).toBe(0);
    expect(calls.execute.some((q) => q.includes("UPDATE reservations"))).toBe(false);
  });
});

describe("storage.getActiveReservationForUser / getActiveReservationForBike", () => {
  it("returns the active reservation row for a user", async () => {
    const row = makeReservation();
    const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve([row]) };
    dbMock.select.mockReturnValue(chain);

    const result = await storage.getActiveReservationForUser("user-1");

    expect(result).toEqual(row);
  });

  it("returns undefined when a bike has no active reservation", async () => {
    const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve([]) };
    dbMock.select.mockReturnValue(chain);

    const result = await storage.getActiveReservationForBike("BC-01");

    expect(result).toBeUndefined();
  });
});

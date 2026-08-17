import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ride } from "@shared/schema";

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

import { storage } from "./storage";

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("endRide charge confirmation push", () => {
  it("confirms the successful ride-end overage amount to the rider", async () => {
    const activeRide = makeRide();
    const completedRide = makeRide({ endedAt: NOW.getTime(), cost: 70000, status: "completed" });
    // Wallet debit for the overage is now a raw tx.execute(sql`UPDATE ...`)
    // (audit CRITICAL #5 — atomic decrement, no SELECT-then-UPDATE round trip),
    // so it no longer shows up as a tx.select()/tx.update() call here.
    const selectResults = [[activeRide], [], [completedRide]];
    const tx: any = {
      select: vi.fn(() => {
        const rows = selectResults.shift() ?? [];
        const chain: any = {
          from: () => chain,
          where: () => chain,
          limit: () => Promise.resolve(rows),
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      }),
      update: vi.fn(() => {
        const chain: any = { set: () => chain, where: () => Promise.resolve() };
        return chain;
      }),
      insert: vi.fn(() => ({ values: () => Promise.resolve() })),
      execute: vi.fn(() => Promise.resolve({ rows: [] })),
    };
    dbMock.transaction.mockImplementation(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx));

    await storage.endRide(activeRide.id);

    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", {
      title: "Оплата поездки",
      body: "Списано 350 ₽ за поездку. Спасибо, что пользуетесь TakeRide!",
      url: "/rides",
      tag: "ride:42:overage",
      data: { kind: "ride-charge-confirmed", rideId: 42 },
    });
  });
});

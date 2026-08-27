import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bikes, rides, tickets, paymentOrders, reservations, alerts, bikeTelemetry,
  rideFeedback, ridePoints, ticketComments, locks,
} from "@shared/schema";

// purgeArchivedTestBike is a permanent, app-level cascading delete for a
// decommissioned DEMO/seed bike (no schema/FK changes involved — see the
// admin route in http/catalog.test.ts... actually not covered there, so this
// file is the sole coverage for both the guard logic and the deletion
// cascade). The per-bike isTestBike operator flag was removed, so a
// demo/seed row from the reseed migration is now the only thing that can
// ever reach the delete path — no more real-rides / paid-orders guards.

const dbMock = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn() }));

vi.mock("./db/bootstrap", () => ({ db: dbMock, pool: {}, bootstrapReady: Promise.resolve() }));

import { DatabaseStorage } from "./storage";

function mockGetBike(bike: Record<string, unknown> | undefined) {
  dbMock.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(bike ? [bike] : []) }) }),
  });
}

/** Fake transaction: routes select()/delete()/update() by table identity.
 * purgeArchivedTestBike only ever selects `{id}` projections (ride/ticket id
 * lookups) now — the old realRidesCount/paidOrdersCount `{c: count()}`
 * projections were removed along with the isTestBike guard. */
function makeTx(opts: {
  rideIds?: number[];
  ticketIds?: number[];
  rowCounts?: Map<unknown, number>;
}) {
  const rideIds = opts.rideIds ?? [];
  const ticketIds = opts.ticketIds ?? [];
  const deletes: unknown[] = [];
  const updates: { table: unknown; set: unknown }[] = [];
  const rowCounts = opts.rowCounts ?? new Map<unknown, number>();

  const tx: any = {
    select: vi.fn(() => {
      let table: unknown;
      const chain: any = {
        from: (t: unknown) => { table = t; return chain; },
        where: () => {
          if (table === rides) return Promise.resolve(rideIds.map((id) => ({ id })));
          if (table === tickets) return Promise.resolve(ticketIds.map((id) => ({ id })));
          return Promise.resolve([]);
        },
      };
      return chain;
    }),
    delete: vi.fn((table: unknown) => ({
      where: () => {
        deletes.push(table);
        return Promise.resolve({ rowCount: rowCounts.get(table) ?? 1 });
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (patch: unknown) => ({
        where: () => { updates.push({ table, set: patch }); return Promise.resolve(); },
      }),
    })),
  };
  return { tx, deletes, updates };
}

const ARCHIVED_SEED_BIKE = { id: "bike-2", seed: true, status: "archived", lockImei: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DatabaseStorage.purgeArchivedTestBike", () => {
  it("refuses a bike that doesn't exist", async () => {
    mockGetBike(undefined);

    const result = await new DatabaseStorage().purgeArchivedTestBike("ghost");

    expect(result).toEqual({ error: "Велосипед не найден" });
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("refuses a bike that is not seed/demo-sidированный, regardless of status", async () => {
    mockGetBike({ ...ARCHIVED_SEED_BIKE, seed: false });

    const result = await new DatabaseStorage().purgeArchivedTestBike("bike-2");

    expect(result).toEqual({ error: "Безвозвратно удалить можно только демо-сидированный велосипед" });
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("refuses a seed bike that has not been archived yet", async () => {
    mockGetBike({ ...ARCHIVED_SEED_BIKE, status: "active" });

    const result = await new DatabaseStorage().purgeArchivedTestBike("bike-2");

    expect(result).toEqual({ error: "Сначала переведите велосипед в архив" });
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("cascades the delete across every dependent table and returns counts", async () => {
    mockGetBike(ARCHIVED_SEED_BIKE);
    const rowCounts = new Map<unknown, number>([
      [rideFeedback, 3], [ridePoints, 40], [ticketComments, 2], [paymentOrders, 1],
      [tickets, 1], [reservations, 1], [alerts, 4], [bikeTelemetry, 500], [rides, 2],
    ]);
    const { tx, deletes } = makeTx({ rideIds: [10, 11], ticketIds: [20], rowCounts });
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));

    const result = await new DatabaseStorage().purgeArchivedTestBike("bike-2");

    expect(result).toEqual({
      ok: true,
      deleted: {
        rides: 2, tickets: 1, paymentOrders: 1, reservations: 1, alerts: 4,
        ticketComments: 2, rideFeedback: 3, ridePoints: 40, telemetry: 500,
      },
    });
    // Every dependent table was actually targeted, in dependency order
    // (children before the rows they reference).
    expect(deletes).toEqual([
      rideFeedback, ridePoints, ticketComments, paymentOrders, tickets,
      reservations, alerts, bikeTelemetry, rides, bikes,
    ]);
  });

  it("skips ride/ticket-scoped deletes entirely when the bike has neither", async () => {
    mockGetBike(ARCHIVED_SEED_BIKE);
    const { tx, deletes } = makeTx({ rideIds: [], ticketIds: [] });
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));

    const result = await new DatabaseStorage().purgeArchivedTestBike("bike-2");

    expect(result).toEqual({
      ok: true,
      deleted: {
        rides: 1, tickets: 1, paymentOrders: 1, reservations: 1, alerts: 1,
        ticketComments: 0, rideFeedback: 0, ridePoints: 0, telemetry: 1,
      },
    });
    expect(deletes).toEqual([paymentOrders, tickets, reservations, alerts, bikeTelemetry, rides, bikes]);
  });

  it("unlinks the physical lock registry entry when the bike had one bound", async () => {
    mockGetBike({ ...ARCHIVED_SEED_BIKE, lockImei: "868000000000001" });
    const { tx, updates } = makeTx({});
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));

    const result = await new DatabaseStorage().purgeArchivedTestBike("bike-2");

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    const lockUpdate = updates.find((u) => u.table === locks);
    expect(lockUpdate).toBeDefined();
    expect(lockUpdate!.set).toEqual(expect.objectContaining({ bikeId: null, updatedAt: expect.any(Number) }));
  });

  it("does not touch the lock registry when no lock was ever bound", async () => {
    mockGetBike(ARCHIVED_SEED_BIKE);
    const { tx, updates } = makeTx({});
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));

    await new DatabaseStorage().purgeArchivedTestBike("bike-2");

    expect(updates).toHaveLength(0);
  });

  it("purges a seed/demo bike even though its rides look like real usage", async () => {
    // Demo fleet rows (seed=true) can carry real-looking ride/order rows
    // from staff poking at the demo environment — there is no real-rides or
    // paid-orders guard for seed bikes, only the archived-status check.
    mockGetBike(ARCHIVED_SEED_BIKE);
    const { tx, deletes } = makeTx({ rideIds: [30, 31], ticketIds: [40] });
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));

    const result = await new DatabaseStorage().purgeArchivedTestBike("bike-2");

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(deletes).toContain(bikes);
  });
});

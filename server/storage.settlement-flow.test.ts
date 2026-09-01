import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike } from "@shared/schema";

// Full settlement-flow coverage: chains storage.startRide() -> storage.endRide()
// against ONE shared, stateful fake DB (not a per-call canned queue like the
// existing isolated endRide unit tests) so these tests pin the actual
// end-to-end financial invariant: every kopeck debited from the wallet across
// the whole ride lifecycle must equal the ride's own final `cost` field, and
// the payments ledger must reconcile with both.
//
// Deliberately still mocks the DB layer (no live Postgres — matches this
// repo's existing unit-test convention, see vitest.config.ts), but the mock
// is a real stateful model of bikes/rides/wallet/payments instead of a
// scripted response queue, so a regression in how startRide and endRide
// cooperate (e.g. double-charging, losing the prepaid-vs-wallet distinction,
// or an overage that doesn't match the final cost) shows up here even though
// each function's own isolated unit tests still pass.

const dbMock = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
const sendToUserAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: sendToUserAsyncMock }));

import { storage, rideEvents } from "./storage";
import { bikes, rides, payments, parkings } from "@shared/schema";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-08-19T12:00:00.000Z");

// h1 tariff: 350 ₽ / 1h paid window. Overage: 12 ₽ per started extra minute.
const H1_KOPECKS = 35000;
const OVERAGE_MINUTE_KOPECKS = 1200; // 12 ₽ per started overage minute

function makeBike(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01",
    lat: 10,
    lng: 20,
    battery: 100,
    status: "available",
    lockImei: null, // no smart lock -> startRide skips the physical-unlock gate entirely
    parkingId: null,
    idleHours: 0,
    updatedAt: NOW.getTime(),
    lastSeen: NOW.getTime(),
    ...overrides,
  } as Bike;
}

// Drizzle's sql`` tagged template stores literal text segments as
// { value: [chunk] } entries interleaved with the raw bound values. Recover
// both back out so the fake tx.execute() can dispatch by query shape without
// depending on drizzle internals beyond this one stable array layout.
function chunkText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown[] })?.value;
      return Array.isArray(v) ? v.join("") : "";
    })
    .join(" ");
}
function chunkParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.filter((c) => !Array.isArray((c as { value?: unknown[] })?.value));
}

// drizzle's eq(column, value) returns a SQL condition whose queryChunks holds
// the column-definition object AND a Param { value } node for the bound
// value. A Column object never carries its own `.value` field, so "has a
// scalar .value property" reliably picks out the Param — this is how the
// fake bikes table below figures out WHICH bike a .where(eq(bikes.id, id))
// call is asking for, without depending on drizzle's Param class directly.
function extractEqValue(cond: unknown): unknown {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  for (const c of chunks) {
    if (c && typeof c === "object" && "value" in c && !Array.isArray((c as { value?: unknown }).value)) {
      return (c as { value: unknown }).value;
    }
  }
  return undefined;
}

interface SettlementState {
  bikes: Map<string, Record<string, unknown>>;
  wallet: { balance: number } | undefined;
  ride: Record<string, unknown> | undefined;
  ridePointsRows: { x: number; y: number; t: number }[];
  paymentRows: Record<string, unknown>[];
  parkingRows: Record<string, unknown>[];
  nextRideId: number;
  nextPaymentId: number;
}

// One shared mutable state object, closed over by every tx returned from
// db.transaction() across BOTH the startRide call and the later endRide
// call — this is what makes the test genuinely end-to-end instead of two
// independent mocks that happen to run in the same file.
// Phase 2 (radius-gating): startRide/endRide now hard-require the bike to be
// within an active parking zone. Every bike fixture in this file sits at the
// makeBike() default (lat: 10, lng: 20) and never overrides it, so a single
// huge-radius zone centered there keeps every existing fixture's geofence
// check passing without having to thread a parking fixture through each test.
function makeSettlementState(fleet: Bike | Bike[], walletBalance: number | undefined): SettlementState {
  const bikeList = Array.isArray(fleet) ? fleet : [fleet];
  return {
    bikes: new Map(bikeList.map((b) => [b.id, { ...b } as Record<string, unknown>])),
    wallet: walletBalance === undefined ? undefined : { balance: walletBalance },
    ride: undefined,
    ridePointsRows: [],
    paymentRows: [],
    parkingRows: [{ id: "P-1", lat: 10, lng: 20, radius: 999999, status: "active", archivedAt: null }],
    nextRideId: 1,
    nextPaymentId: 1,
  };
}

function makeTx(state: SettlementState) {
  function rowsFor(table: unknown, cond: unknown): unknown[] {
    if (table === bikes) {
      const id = extractEqValue(cond);
      if (typeof id === "string") {
        const b = state.bikes.get(id);
        return b ? [b] : [];
      }
      return Array.from(state.bikes.values());
    }
    if (table === rides) return state.ride ? [state.ride] : [];
    if (table === parkings) return state.parkingRows;
    return [];
  }

  const tx: any = {
    select: vi.fn(() => {
      let table: unknown;
      let whereCond: unknown;
      const chain: any = {
        from: (t: unknown) => {
          table = t;
          return chain;
        },
        where: (cond?: unknown) => {
          whereCond = cond;
          return chain;
        },
        for: () => chain,
        limit: (n: number) => Promise.resolve(rowsFor(table, whereCond).slice(0, n)),
        then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(rowsFor(table, whereCond)).then(resolve, reject),
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === rides) {
          return {
            returning: () => {
              const row = { id: state.nextRideId++, ...values };
              state.ride = row;
              return Promise.resolve([row]);
            },
          };
        }
        if (table === payments) {
          const row = { id: state.nextPaymentId++, ...values };
          state.paymentRows.push(row);
          return Promise.resolve([row]);
        }
        return Promise.resolve([]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond?: unknown) => {
          if (table === bikes) {
            const id = extractEqValue(cond);
            const target = typeof id === "string" ? state.bikes.get(id) : undefined;
            // Every bikes update in startRide/endRide targets the bike this ride
            // is/was on; with a single-bike fixture (the common case) fall back
            // to it directly so tests don't need to thread the id through.
            const fallback = state.bikes.size === 1 ? state.bikes.values().next().value : undefined;
            Object.assign(target ?? fallback ?? {}, patch);
          }
          if (table === rides && state.ride) Object.assign(state.ride, patch);
          return Promise.resolve();
        },
      }),
    })),
    execute: vi.fn((query: unknown) => {
      const text = chunkText(query);
      const params = chunkParams(query);

      if (text.includes("SELECT x, y, t FROM ride_points")) {
        return Promise.resolve({ rows: state.ridePointsRows });
      }
      if (text.includes("INSERT INTO ride_points")) {
        const [, x, y, t] = params as [number, number, number, number];
        state.ridePointsRows.push({ x, y, t });
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("INSERT INTO wallet")) {
        const [userId] = params as [string];
        if (!state.wallet) state.wallet = { balance: 0 };
        void userId; // single-wallet fixture; userId only disambiguates in real schema
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("UPDATE wallet SET balance = balance -") && text.includes("RETURNING balance")) {
        // startRide's conditional debit: balance -= cost WHERE balance >= cost
        const [cost] = params as [number, string, number];
        if (!state.wallet || state.wallet.balance < cost) return Promise.resolve({ rows: [] });
        state.wallet.balance -= cost;
        return Promise.resolve({ rows: [{ balance: state.wallet.balance }] });
      }
      if (text.includes("UPDATE wallet SET balance = balance -")) {
        // endRide's unconditional overage debit: allowed to go negative.
        const [overage] = params as [number, string];
        if (!state.wallet) state.wallet = { balance: 0 };
        state.wallet.balance -= overage;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
  return tx;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [] });
  // endRide's pre-transaction funding-order lookup (see
  // chargeRideOverageAsync in server/storage/ride.ts) — every ride in this
  // suite is wallet-funded, so "no funding order found" keeps the legacy
  // wallet-debit overage path exercised end-to-end as these tests intend.
  dbMock.select.mockImplementation(() => {
    const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => Promise.resolve([]) };
    return chain;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("settlement flow — internal wallet payment, no overage", () => {
  it("debits exactly the tariff price at start, nothing more at end, and reconciles cost/ledger/wallet", async () => {
    const state = makeSettlementState(makeBike(), 50000);
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(state)));

    const started = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1" });
    expect(started).not.toHaveProperty("error");
    expect(state.wallet!.balance).toBe(50000 - H1_KOPECKS);
    expect(state.bikes.get("BC-01")!.status).toBe("rented");

    // End exactly at the paid-window boundary -> zero overage.
    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    const ended = await storage.endRide((started as { id: number }).id);

    expect(ended?.status).toBe("completed");
    expect(ended?.cost).toBe(H1_KOPECKS); // no overage added
    expect(state.wallet!.balance).toBe(50000 - H1_KOPECKS); // unchanged since start
    expect(state.paymentRows).toHaveLength(1); // only the start charge
    expect(state.paymentRows[0].amount).toBe(-H1_KOPECKS);
    expect(state.bikes.get("BC-01")!.status).toBe("available");
  });
});

describe("settlement flow — internal wallet payment with overage", () => {
  it("charges the tariff at start and the overage at end, and the two ledger rows sum to the ride's final cost", async () => {
    const state = makeSettlementState(makeBike(), 100000);
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(state)));

    const started = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1" });
    expect(started).not.toHaveProperty("error");
    expect(state.wallet!.balance).toBe(100000 - H1_KOPECKS);

    // Ran 2h30m against a 1h paid window -> 90 started overage minutes.
    vi.setSystemTime(new Date(NOW.getTime() + 2.5 * HOUR));
    const ended = await storage.endRide((started as { id: number }).id);

    const expectedOverage = 90 * OVERAGE_MINUTE_KOPECKS;
    const expectedFinalCost = H1_KOPECKS + expectedOverage;

    expect(ended?.cost).toBe(expectedFinalCost);
    expect(state.wallet!.balance).toBe(100000 - expectedFinalCost);
    expect(state.paymentRows).toHaveLength(2);
    const totalLedgerDebit = -state.paymentRows.reduce((sum, p) => sum + (p.amount as number), 0);
    expect(totalLedgerDebit).toBe(expectedFinalCost); // ledger reconciles with the ride's own cost field
    expect(sendToUserAsyncMock).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ data: { kind: "ride-charge-confirmed", rideId: (started as { id: number }).id } }),
    );
  });

  it("still settles correctly (allows a negative balance) when overage exceeds what remains in the wallet", async () => {
    // Only enough for the base tariff, nothing left for the overage.
    const state = makeSettlementState(makeBike(), H1_KOPECKS);
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(state)));

    const started = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1" });
    expect(state.wallet!.balance).toBe(0);

    vi.setSystemTime(new Date(NOW.getTime() + 1.5 * HOUR)); // 30 started overage minutes
    const ended = await storage.endRide((started as { id: number }).id);

    const overage = 30 * OVERAGE_MINUTE_KOPECKS;
    expect(ended?.cost).toBe(H1_KOPECKS + overage);
    expect(state.wallet!.balance).toBe(-overage); // rider now owes the overage; unblocked, not silently dropped
    expect(state.bikes.get("BC-01")!.status).toBe("available"); // bike is still released even though the rider ends up in debt
  });
});

describe("settlement flow — prepaid (T-Bank) start, wallet-side overage at end", () => {
  it("never touches the wallet at start, but still debits overage from it at end if the ride overruns", async () => {
    // prepaid=true models a ride already paid via T-Bank ride/init — the
    // rider may have zero wallet balance and startRide must not require or
    // touch it.
    const state = makeSettlementState(makeBike(), undefined);
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(state)));

    const started = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1", prepaid: true });
    expect(started).not.toHaveProperty("error");
    expect(state.wallet).toBeUndefined(); // no wallet row created/touched by the prepaid path
    expect(state.paymentRows).toHaveLength(0); // the T-Bank charge is recorded elsewhere, not by startRide

    vi.setSystemTime(new Date(NOW.getTime() + 1.5 * HOUR)); // 30 started overage minutes
    const ended = await storage.endRide((started as { id: number }).id);

    const overage = 30 * OVERAGE_MINUTE_KOPECKS;
    // The ride's recorded cost still reflects the prepaid base + overage...
    expect(ended?.cost).toBe(H1_KOPECKS + overage);
    // ...but only the overage actually moved through the wallet.
    expect(state.wallet!.balance).toBe(-overage);
    expect(state.paymentRows).toHaveLength(1);
    expect(state.paymentRows[0].amount).toBe(-overage);
  });
});

describe("settlement flow — guards that must prevent any settlement at all", () => {
  it("refuses to start (and charges nothing) when the wallet cannot cover the tariff price", async () => {
    const state = makeSettlementState(makeBike(), 1000); // far below the 35000-kopeck h1 price
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(state)));

    const started = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1" });

    expect(started).toEqual({ error: "Недостаточно средств на балансе" });
    expect(state.wallet!.balance).toBe(1000); // untouched
    expect(state.ride).toBeUndefined(); // no ride row was ever created
    expect(state.bikes.get("BC-01")!.status).toBe("available"); // bike never left available
    expect(state.paymentRows).toHaveLength(0);
  });

  it("refuses a second ride for a rider who already has one active, without charging the wallet again — even on a different, available bike", async () => {
    const state = makeSettlementState([makeBike({ id: "BC-01" }), makeBike({ id: "BC-02" })], 200000);
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(state)));

    const first = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1" });
    expect(first).not.toHaveProperty("error");
    const balanceAfterFirst = state.wallet!.balance;

    const second = await storage.startRide({ bikeId: "BC-02", userId: "user-1", tariff: "h2" });

    expect(second).toEqual({ error: "У вас уже есть активная поездка" });
    expect(state.wallet!.balance).toBe(balanceAfterFirst); // no second debit
    expect(state.paymentRows).toHaveLength(1); // only the first ride's charge
    expect(state.bikes.get("BC-02")!.status).toBe("available"); // the second bike was never claimed
  });
});

describe("settlement flow — side effects fire exactly once per real transition", () => {
  it("invalidates the bikes cache and emits start/end rider events at the right moments, not extra times on guarded no-ops", async () => {
    const state = makeSettlementState(makeBike(), 50000);
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(makeTx(state)));
    const cacheSpy = vi.spyOn(storage, "invalidateBikesCache").mockImplementation(() => {});
    const emitSpy = vi.spyOn(rideEvents, "emit");

    const started = await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1" });
    expect(cacheSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy).toHaveBeenCalledWith("user-1", "start");

    // A blocked second start must not fire any more side effects.
    await storage.startRide({ bikeId: "BC-01", userId: "user-1", tariff: "h1" });
    expect(cacheSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(NOW.getTime() + HOUR));
    await storage.endRide((started as { id: number }).id);
    expect(cacheSpy).toHaveBeenCalledTimes(2);
    expect(emitSpy).toHaveBeenCalledWith("user-1", "end");
  });
});

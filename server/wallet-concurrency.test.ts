import { describe, it, expect, beforeEach, vi } from "vitest";

// Wallet balance concurrency (audit M2). The storage layer's topUp/purchaseTariff
// must mutate the balance with an atomic SQL increment, not a read-then-write in
// app code. We mock ./db/bootstrap with an in-memory "pool" that models real
// row-level atomicity: each query runs its read+write to completion before the
// next (as a single Postgres statement does). Because each atomic UPDATE is one
// statement, concurrent top-ups sum correctly. A regression to the old
// read-then-write pattern (writing an absolute balance computed in JS) would
// lose updates and fail these tests.
const store = vi.hoisted(() => ({
  wallets: new Map<string, { userId: string; balance: number; activeTariff: string; tariffExpiresAt: number | null }>(),
  payments: [] as any[],
  nextPaymentId: 1,
  reset() {
    this.wallets.clear();
    this.payments = [];
    this.nextPaymentId = 1;
  },
}));

function makeClient() {
  return {
    // A resolved microtask before each op lets concurrent callers interleave at
    // statement boundaries — exactly where a real pooled client yields.
    async query(text: string, params: any[] = []) {
      await Promise.resolve();
      const sql = text.trim();

      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK")) {
        return { rows: [] };
      }

      // topUp UPSERT: atomic increment.
      if (sql.startsWith("INSERT INTO wallet")) {
        const [userId, amount] = params;
        let w = store.wallets.get(userId);
        if (!w) {
          w = { userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null };
          store.wallets.set(userId, w);
        }
        w.balance += amount;
        return { rows: [{ ...w }] };
      }

      // purchaseTariff conditional atomic debit.
      if (sql.startsWith("UPDATE wallet")) {
        const [userId, price, tariff, expires] = params;
        const w = store.wallets.get(userId);
        if (!w || w.balance < price) return { rows: [] };
        w.balance -= price;
        w.activeTariff = tariff;
        w.tariffExpiresAt = expires;
        return { rows: [{ ...w }] };
      }

      if (sql.startsWith("INSERT INTO payments")) {
        const [userId, amount, description, createdAt] = params;
        const row = { id: store.nextPaymentId++, userId, amount, kind: "x", description, createdAt };
        store.payments.push(row);
        return { rows: [row] };
      }

      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
}

vi.mock("./db/bootstrap", () => ({
  pool: { connect: async () => makeClient() },
  db: {},
  bootstrapReady: Promise.resolve(),
}));

import { storage } from "./storage";

beforeEach(() => store.reset());

describe("wallet balance concurrency (M2)", () => {
  it("two concurrent top-ups both apply — no lost update", async () => {
    await Promise.all([storage.topUp("u1", 1000), storage.topUp("u1", 500)]);
    expect(store.wallets.get("u1")!.balance).toBe(1500);
    expect(store.payments).toHaveLength(2);
  });

  it("many concurrent top-ups sum exactly", async () => {
    await Promise.all(Array.from({ length: 20 }, () => storage.topUp("u2", 100)));
    expect(store.wallets.get("u2")!.balance).toBe(2000);
    expect(store.payments).toHaveLength(20);
  });

  it("concurrent tariff purchases can't overspend a limited balance", async () => {
    store.wallets.set("u3", { userId: "u3", balance: 300, activeTariff: "payg", tariffExpiresAt: null });
    const results = await Promise.allSettled([
      storage.purchaseTariff("u3", "h1", 300, 3_600_000),
      storage.purchaseTariff("u3", "h2", 300, 3_600_000),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(store.wallets.get("u3")!.balance).toBe(0);
  });
});

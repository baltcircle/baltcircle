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
  // Payment rows inserted by THIS client's current transaction — undone on
  // ROLLBACK. Mirrors real Postgres: a rolled-back INSERT never persists,
  // which matters for the idempotency-key insufficient-funds path (the
  // payment placeholder must disappear so a later retry with the same key
  // can still succeed).
  const txPaymentIds = new Set<number>();
  return {
    // A resolved microtask before each op lets concurrent callers interleave at
    // statement boundaries — exactly where a real pooled client yields.
    async query(text: string, params: any[] = []) {
      await Promise.resolve();
      const sql = text.trim();

      if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) {
        txPaymentIds.clear();
        return { rows: [] };
      }
      if (sql.startsWith("ROLLBACK")) {
        for (const id of txPaymentIds) {
          const idx = store.payments.findIndex((p) => p.id === id);
          if (idx >= 0) store.payments.splice(idx, 1);
        }
        txPaymentIds.clear();
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
        // Idempotency-key variant (audit MEDIUM): simulate the partial UNIQUE
        // index via an explicit conflict check — ON CONFLICT DO NOTHING.
        if (sql.includes("idempotency_key")) {
          const [userId, amount, description, createdAt, idempotencyKey] = params;
          const conflict = store.payments.some((p) => p.userId === userId && p.idempotencyKey === idempotencyKey);
          if (conflict) return { rows: [] };
          const row = { id: store.nextPaymentId++, userId, amount, kind: "tariff_purchase", description, createdAt, idempotencyKey };
          store.payments.push(row);
          txPaymentIds.add(row.id);
          return { rows: [row] };
        }
        const [userId, amount, description, createdAt] = params;
        const row = { id: store.nextPaymentId++, userId, amount, kind: "x", description, createdAt };
        store.payments.push(row);
        txPaymentIds.add(row.id);
        return { rows: [row] };
      }

      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
}

// Direct pool.query calls (outside any client transaction) — used by
// purchaseTariff's idempotency-replay branch to read back the winning
// request's committed payment row + the current wallet after it has lost the
// insert race and rolled back its own attempt.
async function poolQuery(text: string, params: any[] = []) {
  await Promise.resolve();
  const sql = text.trim();
  if (sql.startsWith("SELECT") && sql.includes("FROM payments")) {
    const [userId, idempotencyKey] = params;
    const row = store.payments.find((p) => p.userId === userId && p.idempotencyKey === idempotencyKey);
    return { rows: row ? [row] : [] };
  }
  if (sql.startsWith("SELECT") && sql.includes("FROM wallet")) {
    const [userId] = params;
    const w = store.wallets.get(userId);
    return { rows: w ? [{ ...w }] : [] };
  }
  throw new Error(`unexpected pool query: ${sql}`);
}

vi.mock("./db/bootstrap", () => ({
  pool: { connect: async () => makeClient(), query: poolQuery },
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

  // Audit MEDIUM: /api/wallet/tariff idempotency.
  it("two concurrent tariff purchases with the SAME idempotency key debit only once", async () => {
    store.wallets.set("u4", { userId: "u4", balance: 500, activeTariff: "payg", tariffExpiresAt: null });
    const [r1, r2] = await Promise.all([
      storage.purchaseTariff("u4", "h1", 300, 3_600_000, "same-key"),
      storage.purchaseTariff("u4", "h1", 300, 3_600_000, "same-key"),
    ]);
    expect(store.wallets.get("u4")!.balance).toBe(200);
    expect(r1.payment.id).toBe(r2.payment.id);
    expect(store.payments.filter((p) => p.idempotencyKey === "same-key")).toHaveLength(1);
  });

  it("a failed attempt does not burn the idempotency key — retry after top-up succeeds", async () => {
    store.wallets.set("u5", { userId: "u5", balance: 100, activeTariff: "payg", tariffExpiresAt: null });
    await expect(storage.purchaseTariff("u5", "h1", 300, 3_600_000, "retry-key")).rejects.toThrow("Недостаточно средств");
    expect(store.payments.filter((p) => p.idempotencyKey === "retry-key")).toHaveLength(0);

    store.wallets.get("u5")!.balance = 300;
    const result = await storage.purchaseTariff("u5", "h1", 300, 3_600_000, "retry-key");
    expect(result.wallet.balance).toBe(0);
    expect(store.payments.filter((p) => p.idempotencyKey === "retry-key")).toHaveLength(1);
  });

  it("a retry with the same key after success replays the original payment without a second debit", async () => {
    store.wallets.set("u6", { userId: "u6", balance: 1000, activeTariff: "payg", tariffExpiresAt: null });
    const first = await storage.purchaseTariff("u6", "h1", 300, 3_600_000, "dup-key");
    const second = await storage.purchaseTariff("u6", "h1", 300, 3_600_000, "dup-key");
    expect(store.wallets.get("u6")!.balance).toBe(700);
    expect(second.payment.id).toBe(first.payment.id);
  });
});

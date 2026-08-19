import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  users, rides, phoneChangeRequests, emailChangeRequests, oauthIdentities,
  pushSubscriptions, otpRequests, paymentMethods, supportTickets,
  supportConversations, supportMessages, paymentOrders,
} from "@shared/schema";

const dbMock = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: {},
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: vi.fn() }));

import { DatabaseStorage } from "./storage";

// drizzle's eq(column, value) queryChunks hold the column ref plus a Param
// node for the bound value; a Param is the only chunk with a non-array
// `.value`, which is what makes it distinguishable from both the raw column
// ref (no `.value`) and a StringChunk (`.value` is an array). Same helper as
// used in storage.settlement-flow.test.ts / storage.locks.test.ts.
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

// Recovers the literal SQL text around a tagged sql`` template's bound
// values, ignoring the values themselves — enough to tell which raw
// tx.execute() query fired (session-table probe vs the session DELETE).
function chunkText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown[] })?.value;
      return Array.isArray(v) ? v.join("") : "";
    })
    .join(" ");
}

interface FakeUser { phone: string; deletedAt: number | null }

/** One fake tx per call, closed over recorded delete()/update()/execute() calls. */
function makeTx(opts: { user: FakeUser | undefined; hasActiveRide: boolean; sessionTableExists: boolean }) {
  const deletes: { table: unknown; value: unknown }[] = [];
  const updates: { table: unknown; set: unknown; value: unknown }[] = [];
  const executed: string[] = [];

  const tx: any = {
    select: vi.fn(() => {
      let table: unknown;
      const chain: any = {
        from: (t: unknown) => { table = t; return chain; },
        where: () => chain,
        for: () => chain,
        limit: () => {
          if (table === users) return Promise.resolve(opts.user ? [opts.user] : []);
          if (table === rides) return Promise.resolve(opts.hasActiveRide ? [{ id: 1 }] : []);
          return Promise.resolve([]);
        },
      };
      return chain;
    }),
    delete: vi.fn((table: unknown) => ({
      where: (cond: unknown) => {
        deletes.push({ table, value: extractEqValue(cond) });
        return Promise.resolve();
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (patch: unknown) => ({
        where: (cond: unknown) => {
          updates.push({ table, set: patch, value: extractEqValue(cond) });
          return Promise.resolve();
        },
      }),
    })),
    execute: vi.fn((query: unknown) => {
      const text = chunkText(query);
      executed.push(text);
      if (text.includes("to_regclass")) {
        return Promise.resolve({ rows: [{ session_table: opts.sessionTableExists ? "session" : null }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
  return { tx, deletes, updates, executed };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DatabaseStorage.deleteAccount", () => {
  it("hard-deletes direct identifiers, anonymizes profile PII, and leaves financial/ride history intact", async () => {
    const { tx, deletes, updates, executed } = makeTx({
      user: { phone: "+79991234567", deletedAt: null },
      hasActiveRide: false,
      sessionTableExists: true,
    });
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));

    const result = await new DatabaseStorage().deleteAccount("user-1");

    expect(result).toEqual({ ok: true });

    for (const table of [
      phoneChangeRequests, emailChangeRequests, oauthIdentities,
      pushSubscriptions, paymentMethods, supportTickets,
      supportConversations, supportMessages,
    ]) {
      expect(deletes.some((d) => d.table === table && d.value === "user-1")).toBe(true);
    }
    // otpRequests is keyed by phone, not userId.
    expect(deletes.some((d) => d.table === otpRequests && d.value === "+79991234567")).toBe(true);

    // Session cleanup goes through raw tx.execute (connect-pg-simple's table
    // has no Drizzle schema); confirm both the existence probe and the
    // conditional DELETE fired.
    expect(executed.some((t) => t.includes("to_regclass"))).toBe(true);
    expect(executed.some((t) => t.includes('DELETE FROM "session"'))).toBe(true);

    const userUpdate = updates.find((u) => u.table === users)!;
    expect(userUpdate).toBeDefined();
    expect(userUpdate.value).toBe("user-1");
    expect(userUpdate.set).toEqual(
      expect.objectContaining({
        name: "Удалённый пользователь",
        email: null,
        emailVerifiedAt: null,
        consentAcceptedAt: null,
        consentVersion: null,
        consentIp: null,
        blockedAt: null,
        blockedReason: null,
        deletedAt: expect.any(Number),
        updatedAt: expect.any(Number),
      }),
    );

    // Rides, ride points, payments, wallet, and payment_orders remain — only
    // a reusable payment token/reference on payment_orders is cleared, via
    // UPDATE (never DELETE).
    for (const table of [rides, paymentOrders]) {
      expect(deletes.some((d) => d.table === table)).toBe(false);
    }
    const ordersUpdate = updates.find((u) => u.table === paymentOrders)!;
    expect(ordersUpdate).toBeDefined();
    expect(ordersUpdate.value).toBe("user-1");
    expect(ordersUpdate.set).toEqual(
      expect.objectContaining({ paymentMethodId: null, rebillId: null, updatedAt: expect.any(Number) }),
    );
  });

  it("returns an active-ride block before erasing any account data", async () => {
    const { tx, deletes, updates } = makeTx({
      user: { phone: "+79991234567", deletedAt: null },
      hasActiveRide: true,
      sessionTableExists: true,
    });
    dbMock.transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(tx));

    const result = await new DatabaseStorage().deleteAccount("user-1");

    expect(result).toEqual({ error: "active_ride" });
    expect(deletes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

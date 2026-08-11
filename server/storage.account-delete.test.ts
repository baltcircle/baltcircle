import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const connectMock = vi.hoisted(() => vi.fn());

vi.mock("./db/bootstrap", () => ({
  db: {},
  pool: { connect: connectMock },
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: vi.fn() }));

import { DatabaseStorage } from "./storage";

beforeEach(() => {
  vi.clearAllMocks();
  connectMock.mockResolvedValue({ query: queryMock, release: releaseMock });
  queryMock.mockImplementation(async (statement: string) => {
    if (statement.includes("SELECT phone, deleted_at FROM users")) {
      return { rows: [{ phone: "+79991234567", deleted_at: null }], rowCount: 1 };
    }
    if (statement.includes("SELECT 1 FROM rides")) return { rows: [], rowCount: 0 };
    if (statement.includes("to_regclass")) return { rows: [{ session_table: "session" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
});

describe("DatabaseStorage.deleteAccount", () => {
  it("hard-deletes direct identifiers, anonymizes profile PII, and leaves financial/ride history intact", async () => {
    const result = await new DatabaseStorage().deleteAccount("user-1");
    const statements = queryMock.mock.calls.map(([statement]) => String(statement).replace(/\s+/g, " "));

    expect(result).toEqual({ ok: true });
    expect(statements).toContain("BEGIN");
    expect(statements).toContain("COMMIT");
    for (const table of [
      "phone_change_requests", "email_change_requests", "oauth_identities",
      "push_subscriptions", "otp_requests", "payment_methods",
      "support_tickets", "support_conversations",
    ]) {
      expect(statements.some((statement) => statement.includes(`DELETE FROM ${table}`))).toBe(true);
    }
    expect(statements.some((statement) => statement.includes('DELETE FROM "session"'))).toBe(true);

    const userUpdate = statements.find((statement) => statement.includes("UPDATE users"))!;
    expect(userUpdate).toContain("name = 'Удалённый пользователь'");
    expect(userUpdate).toContain("email = NULL");
    expect(userUpdate).toContain("consent_ip = NULL");
    expect(userUpdate).toContain("deleted_at = $2");

    // Rides, ride points, payments, wallet, and payment_orders remain. Only a
    // reusable payment token/reference on payment_orders is cleared.
    expect(statements.some((statement) => /^DELETE FROM (rides|ride_points|payments|wallet|payment_orders)/.test(statement))).toBe(false);
    expect(statements.some((statement) => statement.includes("UPDATE payment_orders") && statement.includes("rebill_id = NULL"))).toBe(true);
  });

  it("returns an active-ride block before erasing any account data", async () => {
    queryMock.mockImplementation(async (statement: string) => {
      if (statement.includes("SELECT phone, deleted_at FROM users")) {
        return { rows: [{ phone: "+79991234567", deleted_at: null }], rowCount: 1 };
      }
      if (statement.includes("SELECT 1 FROM rides")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const result = await new DatabaseStorage().deleteAccount("user-1");
    const statements = queryMock.mock.calls.map(([statement]) => String(statement));

    expect(result).toEqual({ error: "active_ride" });
    expect(statements).toContain("ROLLBACK");
    expect(statements.some((statement) => statement.includes("UPDATE users"))).toBe(false);
    expect(statements.some((statement) => statement.includes("DELETE FROM payment_methods"))).toBe(false);
  });
});

// Test rides (isTest=true, POST /api/rides/start-test, operator/admin only)
// must be excluded from every rider/staff history feed backed by
// storage.listRides — GET /api/rides, used by RidesPage.tsx, DrawerMenu.tsx,
// and AdminPage.tsx's unfiltered staff dashboard feed. This is verified by
// inspecting the drizzle WHERE condition actually passed to db.select() —
// listAdminRides (the ops audit table) intentionally has no such filter and
// is NOT covered here.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: { query: vi.fn() },
  bootstrapReady: Promise.resolve(),
}));

import { storage } from "./storage";

// Walks a drizzle SQL condition tree collecting every string leaf/name field
// (columns carry their DB column name at `.name`), without choking on the
// internal cyclic table<->column references real drizzle objects have.
function collectNames(value: unknown, seen = new Set<unknown>()): string[] {
  if (value == null || typeof value !== "object") {
    return typeof value === "string" ? [value] : [];
  }
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  const obj = value as Record<string, unknown>;
  if (typeof obj.name === "string") out.push(obj.name);
  for (const key of Object.keys(obj)) {
    try {
      out.push(...collectNames(obj[key], seen));
    } catch {
      // ignore getters that throw
    }
  }
  return out;
}

function makeSelectChain(capturedWhere: { value: unknown }[]) {
  const chain: any = {
    from: () => chain,
    where: (cond: unknown) => {
      capturedWhere.push({ value: cond });
      return chain;
    },
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listRides — excludes test rides from history/feed views", () => {
  it("filters on is_test = false for the global (staff dashboard) feed", async () => {
    const wheres: { value: unknown }[] = [];
    dbMock.select.mockImplementation(() => makeSelectChain(wheres));

    await storage.listRides({ limit: 50 });

    expect(wheres.length).toBe(1);
    expect(collectNames(wheres[0].value)).toContain("is_test");
  });

  it("filters on is_test = false AND scopes by userId for a rider's own history", async () => {
    const wheres: { value: unknown }[] = [];
    dbMock.select.mockImplementation(() => makeSelectChain(wheres));

    await storage.listRides({ userId: "user-1", limit: 50 });

    expect(wheres.length).toBe(1);
    const names = collectNames(wheres[0].value);
    expect(names).toContain("is_test");
    expect(names).toContain("user_id");
  });
});

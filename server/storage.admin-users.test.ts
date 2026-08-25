import { beforeEach, describe, expect, it, vi } from "vitest";
import { users, rides, rideFeedback } from "@shared/schema";
import type { User } from "@shared/schema";

// listUsers() enriches each admin-table row with a completed-ride count and
// mean feedback rating, computed via two grouped queries merged in memory —
// this covers that aggregation (zero rides, rides with no feedback, rides
// with feedback, and that non-completed rides are excluded from the count).

const dbMock = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("./db/bootstrap", () => ({ db: dbMock, pool: {}, bootstrapReady: Promise.resolve() }));

import { storage } from "./storage";

function userRow(overrides: Partial<User> = {}): User {
  return {
    id: "u1", name: "Test", phone: "+70000000000", email: null, emailVerifiedAt: null,
    role: "rider", consentAcceptedAt: null, consentVersion: null, consentIp: null,
    blockedAt: null, blockedReason: null, deletedAt: null, createdAt: 0, updatedAt: null,
    ...overrides,
  } as User;
}

/** Chainable thenable mimicking the drizzle query builder: `.from()` records
 * which table was targeted so `await` resolves with the right mocked rows,
 * regardless of which where/orderBy/groupBy/limit/offset/$dynamic calls
 * listUsers() happens to chain on top. */
function mockQueries(opts: {
  userRows: User[];
  rideCounts?: { userId: string; c: number }[];
  ratings?: { userId: string; avgRating: string | null }[];
}) {
  dbMock.select.mockImplementation(() => {
    let table: unknown;
    const chain: any = {
      from: (t: unknown) => { table = t; return chain; },
      where: () => chain,
      orderBy: () => chain,
      groupBy: () => chain,
      $dynamic: () => chain,
      limit: () => chain,
      offset: () => chain,
      then: (resolve: any, reject: any) => {
        const result =
          table === users ? opts.userRows :
          table === rides ? (opts.rideCounts ?? []) :
          table === rideFeedback ? (opts.ratings ?? []) : [];
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listUsers aggregates", () => {
  it("returns rideCount 0 and avgRating null for a user with no rides", async () => {
    mockQueries({ userRows: [userRow({ id: "u1" })] });
    const [u] = await storage.listUsers();
    expect(u.rideCount).toBe(0);
    expect(u.avgRating).toBeNull();
  });

  it("returns rideCount without a rating when rides exist but no feedback was left", async () => {
    mockQueries({
      userRows: [userRow({ id: "u1" })],
      rideCounts: [{ userId: "u1", c: 3 }],
    });
    const [u] = await storage.listUsers();
    expect(u.rideCount).toBe(3);
    expect(u.avgRating).toBeNull();
  });

  it("computes avgRating from ride_feedback, rounded to 2 decimals", async () => {
    mockQueries({
      userRows: [userRow({ id: "u1" })],
      rideCounts: [{ userId: "u1", c: 5 }],
      ratings: [{ userId: "u1", avgRating: "4.3333333" }],
    });
    const [u] = await storage.listUsers();
    expect(u.rideCount).toBe(5);
    expect(u.avgRating).toBeCloseTo(4.33, 2);
  });

  it("keeps each user's aggregates independent across a page of several users", async () => {
    mockQueries({
      userRows: [userRow({ id: "u1" }), userRow({ id: "u2" })],
      rideCounts: [{ userId: "u1", c: 2 }],
      ratings: [{ userId: "u2", avgRating: "5" }],
    });
    const [u1, u2] = await storage.listUsers();
    expect(u1.rideCount).toBe(2);
    expect(u1.avgRating).toBeNull();
    expect(u2.rideCount).toBe(0);
    expect(u2.avgRating).toBe(5);
  });

  it("returns an empty array without querying aggregates when there are no users", async () => {
    mockQueries({ userRows: [] });
    const rows = await storage.listUsers();
    expect(rows).toEqual([]);
    // Only the base users query should have run — no rides/ride_feedback
    // lookups for an empty id list (would otherwise be an invalid IN ()).
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RideFeedback } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: vi.fn() }));

import { storage } from "./storage";

function feedbackRow(overrides: Partial<RideFeedback> = {}): RideFeedback {
  return {
    id: 1, rideId: 10, userId: "u1", rating: 1, reasons: [], comment: null, createdAt: 0,
    ...overrides,
  } as RideFeedback;
}

// Mocks db.insert(...).values(...).onConflictDoUpdate(...).returning() and
// records the call args so tests can assert the upsert target/shape.
function mockInsertReturning(row: RideFeedback) {
  const calls: { values?: unknown; conflict?: unknown } = {};
  dbMock.insert.mockImplementation(() => ({
    values: (v: unknown) => {
      calls.values = v;
      return {
        onConflictDoUpdate: (c: unknown) => {
          calls.conflict = c;
          return { returning: () => Promise.resolve([row]) };
        },
      };
    },
  }));
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [] });
});

describe("submitRideFeedback", () => {
  it("accepts reasons from the low tier (rating <= 3)", async () => {
    mockInsertReturning(feedbackRow({ rating: 2, reasons: ["dirty", "brakes"] }));
    const r = await storage.submitRideFeedback(10, "u1", { rating: 2, reasons: ["dirty", "brakes"], comment: "" });
    expect("error" in r).toBe(false);
    expect((r as RideFeedback).reasons).toEqual(["dirty", "brakes"]);
  });

  it("accepts reasons from the mid tier (rating === 4)", async () => {
    mockInsertReturning(feedbackRow({ rating: 4, reasons: ["price_high"] }));
    const r = await storage.submitRideFeedback(10, "u1", { rating: 4, reasons: ["price_high"], comment: "" });
    expect("error" in r).toBe(false);
  });

  it("accepts reasons from the high tier (rating === 5)", async () => {
    mockInsertReturning(feedbackRow({ rating: 5, reasons: ["good_price"] }));
    const r = await storage.submitRideFeedback(10, "u1", { rating: 5, reasons: ["good_price"], comment: "" });
    expect("error" in r).toBe(false);
  });

  it("rejects a reason id that belongs to a different tier's pool", async () => {
    // "good_price" is a high-tier id; submitting it with a low rating must fail
    // rather than silently accepting it (would corrupt future analytics).
    mockInsertReturning(feedbackRow());
    const r = await storage.submitRideFeedback(10, "u1", { rating: 1, reasons: ["good_price"], comment: "" });
    expect(r).toEqual({ error: "Некорректная причина отзыва" });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("de-dupes repeated reason ids before persisting", async () => {
    const calls = mockInsertReturning(feedbackRow({ rating: 1, reasons: ["dirty"] }));
    await storage.submitRideFeedback(10, "u1", { rating: 1, reasons: ["dirty", "dirty"], comment: "" });
    expect((calls.values as any).reasons).toEqual(["dirty"]);
  });

  it("upserts on rideId conflict instead of duplicating (resubmission for the same ride)", async () => {
    const calls = mockInsertReturning(feedbackRow({ rating: 3, reasons: [] }));
    await storage.submitRideFeedback(10, "u1", { rating: 3, reasons: [], comment: "updated" });
    expect(calls.conflict).toBeTruthy();
    expect((calls.conflict as any).target).toBeDefined();
  });

  it("normalizes an empty/whitespace comment to null", async () => {
    const calls = mockInsertReturning(feedbackRow());
    await storage.submitRideFeedback(10, "u1", { rating: 1, reasons: [], comment: "   " });
    expect((calls.values as any).comment).toBeNull();
  });
});

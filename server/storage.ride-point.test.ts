import { describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn(), execute: vi.fn() }));
vi.mock("./db/bootstrap", () => ({ db, pool: { query: vi.fn() }, bootstrapReady: Promise.resolve() }));
import { storage } from "./storage";

describe("retired phone point writer", () => {
  it("cannot mutate distance or position even through an internal call", async () => {
    expect(await storage.appendRidePoint(42, 1, 2)).toBeUndefined();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });
});

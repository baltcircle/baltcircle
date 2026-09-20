import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("../db/bootstrap", () => ({ pool: { query } }));
import { lockTrackPage, legacyLockTrack } from "./lock-track";

beforeEach(() => query.mockReset());
describe("bounded lock route reads", () => {
  it("returns 500 fixes and a delivery cursor, not the latest GPS timestamp", async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      id: 1001 + i, x: 1, y: 2, t: i === 499 ? 10 : 10000 + i,
    }));
    query.mockResolvedValue({ rows });
    const result = await lockTrackPage(7, 1000);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY id LIMIT 501"), [7, 1000]);
    expect(result.items).toHaveLength(500);
    expect(result.nextCursor).toBe(1500);
    expect(result.hasMore).toBe(true);
    expect(result.source).toBe("tracker");
    expect(result.items[499].t).toBe(10);
  });
  it("keeps the cursor on an empty page so reconnection cannot replay the route", async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await lockTrackPage(7, 1500)).toEqual({
      source: "tracker", items: [], nextCursor: 1500, hasMore: false,
    });
  });
  it("serves old tabs only lock fixes, never phone data", async () => {
    query.mockResolvedValue({ rows: [{ x: 1, y: 2, t: 3 }] });
    expect(await legacyLockTrack(7)).toEqual({ source: "tracker", points: [[1, 2, 3]] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM ride_lock_points"), [7]);
  });
});

import { describe, expect, it } from "vitest";
import { historyCursor, rideHistoryCursor, supportPage } from "./rider-data";

describe("rider cursor pagination", () => {
  it("rejects invalid cursors instead of accidentally returning someone else's data", () => {
    expect(historyCursor("NaN")).toBeUndefined();
    expect(historyCursor("-2")).toBeUndefined();
    expect(historyCursor("1.4")).toBeUndefined();
    expect(historyCursor("12")).toBe(12);
    expect(rideHistoryCursor("100:12")).toEqual({ startedAt: 100, id: 12 });
    expect(rideHistoryCursor("100:-1")).toBeUndefined();
    expect(rideHistoryCursor("100:12:3")).toBeUndefined();
  });
  it("returns the latest chronological page and a cursor for every older message", () => {
    const descending = Array.from({ length: 51 }, (_, i) => ({ id: 300 - i }));
    const result = supportPage(descending, 50);
    expect(result.messages[0].id).toBe(251);
    expect(result.messages.at(-1)?.id).toBe(300);
    expect(result.nextBefore).toBe(251);
    expect(supportPage([{ id: 1 }], 50).nextBefore).toBeNull();
    expect(supportPage([], 50).messages).toEqual([]);
  });
});

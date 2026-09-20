import { describe, expect, it } from "vitest";
import { appendLockTrack, type LockTrackPage } from "./lock-track";

const page = (id: number, t: number): LockTrackPage => ({
  source: "tracker", items: [{ id, t, x: id, y: id }], nextCursor: id, hasMore: false,
});
describe("incremental lock route", () => {
  it("deduplicates replayed pages and retains late points in timestamp order", () => {
    const first = appendLockTrack(undefined, [page(1, 100), page(2, 300)]);
    const next = appendLockTrack(first, [page(2, 300), page(3, 200)]);
    expect(next.items.map((p) => p.id)).toEqual([1, 3, 2]);
    expect(next.nextCursor).toBe(3);
    expect(next.lastPointAt).toBe(300);
  });
  it("retains different points with identical timestamps", () => {
    expect(appendLockTrack(undefined, [page(1, 100), page(2, 100)]).points).toHaveLength(2);
  });
  it("empty polling never deletes the last known position", () => {
    const first = appendLockTrack(undefined, [page(1, 100)]);
    expect(appendLockTrack(first, [{ source: "tracker", items: [], nextCursor: 1, hasMore: false }])).toEqual(first);
  });
  it("starts a separate ride without the other ride's cursor", () => {
    expect(appendLockTrack(undefined, []).nextCursor).toBe(0);
    expect(appendLockTrack(undefined, []).points).toEqual([]);
  });
});

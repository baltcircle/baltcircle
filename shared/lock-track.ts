import type { TrackPoint } from "./rideTrack";

export interface LockTrackPoint { id: number; x: number; y: number; t: number }
export interface LockTrackPage {
  source: "tracker";
  items: LockTrackPoint[];
  nextCursor: number;
  hasMore: boolean;
}
export interface LockTrackState {
  source: "tracker";
  items: LockTrackPoint[];
  points: TrackPoint[];
  nextCursor: number;
  lastPointAt: number | null;
}

// IDs are the delivery cursor, timestamps are the route order. A delayed fix
// therefore isn't skipped, even when it predates the last displayed position.
export function appendLockTrack(previous: LockTrackState | undefined, pages: LockTrackPage[]): LockTrackState {
  if (previous && pages.every((page) => page.items.length === 0 && page.nextCursor === previous.nextCursor)) {
    return previous;
  }
  const byId = new Map((previous?.items ?? []).map((p) => [p.id, p]));
  let nextCursor = previous?.nextCursor ?? 0;
  for (const page of pages) {
    for (const point of page.items) byId.set(point.id, point);
    nextCursor = Math.max(nextCursor, page.nextCursor);
  }
  const items = Array.from(byId.values()).sort((a, b) => a.t - b.t || a.id - b.id);
  return {
    source: "tracker", items, nextCursor,
    points: items.map((p) => [p.x, p.y, p.t]),
    lastPointAt: items.at(-1)?.t ?? null,
  };
}

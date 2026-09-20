import { pool } from "../db/bootstrap";
import type { LockTrackPage, LockTrackPoint } from "@shared/lock-track";

export async function lockTrackPage(rideId: number, after: number): Promise<LockTrackPage> {
  const { rows } = await pool.query<LockTrackPoint>(
    `SELECT id,x,y,t FROM ride_lock_points WHERE ride_id=$1 AND id>$2 ORDER BY id LIMIT 501`,
    [rideId, after],
  );
  const items = rows.slice(0, 500);
  return { source: "tracker", items, nextCursor: items.at(-1)?.id ?? after, hasMore: rows.length > 500 };
}

// Compatibility for old open tabs. The new client always requests bounded pages.
export async function legacyLockTrack(rideId: number) {
  const { rows } = await pool.query<LockTrackPoint>(
    "SELECT x,y,t FROM ride_lock_points WHERE ride_id=$1 ORDER BY t,id", [rideId],
  );
  return { source: "tracker" as const, points: rows.map((p) => [p.x, p.y, p.t]) };
}

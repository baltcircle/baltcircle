// In-process bridge between the admin bike-status-change flow (HTTP) and the
// OMNI lock's autonomous "position" (D0) report that lands once a short
// burst-tracking window (armed by server/omni/server.ts's requestGpsRefresh)
// catches a fresh fix. Mirrors pause-registry.ts's shape and rationale: the
// server can only ARM a short-lived expectation and wait for the device to
// report a position on its own, it cannot force one to arrive instantly
// (cold GPS fix is ~2.5min, see shared/geo.ts's GPS_REFRESH_BURST_WINDOW_MS).
//
// Deliberately dependency-free (no Drizzle/storage imports) so it can be
// required from both server/omni/server.ts and server/omni/store.ts without
// pulling omni/store.ts into the full schema graph (see its file header).
export interface PendingGpsRefresh {
  bikeId: string;
  imei: string;
  expiresAt: number;
}

const pending = new Map<string, PendingGpsRefresh>(); // keyed by imei — one pending refresh per lock

/** Arm a GPS-refresh expectation for this lock. Replaces any previous (expired or not) entry for the same IMEI. */
export function registerPendingGpsRefresh(imei: string, bikeId: string, ttlMs: number): void {
  pending.set(imei, { bikeId, imei, expiresAt: Date.now() + ttlMs });
}

/** True if a not-yet-expired GPS refresh is currently armed for this lock. */
export function hasPendingGpsRefresh(imei: string): boolean {
  const entry = pending.get(imei);
  return !!entry && entry.expiresAt > Date.now();
}

/**
 * Consume the pending GPS refresh for this IMEI if one is armed and not
 * expired. One-shot: always removes the entry so a single valid fix cannot
 * double-fire, and a later unrelated position report doesn't resolve a stale
 * request.
 */
export function consumePendingGpsRefresh(imei: string): PendingGpsRefresh | null {
  const entry = pending.get(imei);
  if (!entry) return null;
  pending.delete(imei);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

/** Drop an armed expectation without consuming it (e.g. a ride starts on this lock and takes over its D1 tracking). */
export function clearPendingGpsRefresh(imei: string): void {
  pending.delete(imei);
}

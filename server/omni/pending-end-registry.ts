// In-process bridge between the rider-facing end request (HTTP) and the OMNI
// lock's autonomous "lockReport" (L1) that arrives when the rider physically
// closes the lock. Mirrors pause-registry.ts's shape and rationale exactly:
// there is no server-initiated "close" command in the OMNI protocol, only an
// L0 unlock — the server can only ARM a short-lived expectation and wait for
// the device to report the closure on its own.
//
// Deliberately dependency-free (no Drizzle/storage imports) so it can be
// required from both server/http/rides.ts (via server/storage/ride.ts) and
// server/omni/store.ts without pulling omni/store.ts into the full schema
// graph (see its file header).
export interface PendingEnd {
  rideId: number;
  userId: string;
  imei: string;
  expiresAt: number;
}

const pending = new Map<string, PendingEnd>(); // keyed by imei — one pending end per lock

/** Arm an end expectation for this lock. Replaces any previous (expired or not) entry for the same IMEI. */
export function registerPendingEnd(imei: string, rideId: number, userId: string, ttlMs: number): void {
  pending.set(imei, { rideId, userId, imei, expiresAt: Date.now() + ttlMs });
}

/** True if a not-yet-expired end request is currently armed for this lock. */
export function hasPendingEnd(imei: string): boolean {
  const entry = pending.get(imei);
  return !!entry && entry.expiresAt > Date.now();
}

/**
 * Consume the pending end for this IMEI if one is armed and not expired.
 * One-shot: always removes the entry so a single lockReport cannot double-fire
 * an end (or resolve a stale request from a later, unrelated closure).
 */
export function consumePendingEnd(imei: string): PendingEnd | null {
  const entry = pending.get(imei);
  if (!entry) return null;
  pending.delete(imei);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

/** Drop an armed expectation without consuming it (e.g. the rider cancels, or a pause request supersedes it). */
export function clearPendingEnd(imei: string): void {
  pending.delete(imei);
}

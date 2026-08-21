// In-process bridge between the rider-facing pause request (HTTP) and the
// OMNI lock's autonomous "lockReport" (L1) that arrives when the rider
// physically closes the lock. There is no server-initiated "close" command in
// the OMNI protocol (only L0 unlock) — the server can only ARM a short-lived
// expectation and wait for the device to report the closure on its own,
// mirroring how sendUnlockCommand awaits an L0 echo but for a passive report.
//
// Deliberately dependency-free (no Drizzle/storage imports) so it can be
// required from both server/http/rides.ts and server/omni/store.ts without
// pulling omni/store.ts into the full schema graph (see its file header).
export interface PendingPause {
  rideId: number;
  userId: string;
  imei: string;
  expiresAt: number;
}

const pending = new Map<string, PendingPause>(); // keyed by imei — one pending pause per lock

/** Arm a pause expectation for this lock. Replaces any previous (expired or not) entry for the same IMEI. */
export function registerPendingPause(imei: string, rideId: number, userId: string, ttlMs: number): void {
  pending.set(imei, { rideId, userId, imei, expiresAt: Date.now() + ttlMs });
}

/** True if a not-yet-expired pause is currently armed for this lock. */
export function hasPendingPause(imei: string): boolean {
  const entry = pending.get(imei);
  return !!entry && entry.expiresAt > Date.now();
}

/**
 * Consume the pending pause for this IMEI if one is armed and not expired.
 * One-shot: always removes the entry so a single lockReport cannot double-fire
 * a pause (or resolve a stale request from a later, unrelated closure).
 */
export function consumePendingPause(imei: string): PendingPause | null {
  const entry = pending.get(imei);
  if (!entry) return null;
  pending.delete(imei);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

/** Drop an armed expectation without consuming it (e.g. the rider cancels, or the ride ends). */
export function clearPendingPause(imei: string): void {
  pending.delete(imei);
}

// Tracks runs of accurate GPS fixes that the jump plausibility check rejected,
// per lock, so a genuine relocation (bike trucked between towns) can re-anchor
// the stored position instead of being rejected forever. See
// RELOCATION_CONFIRM_FIXES in shared/geo.ts.
//
// In-memory and dependency-free like theft-registry.ts: a process restart only
// costs RELOCATION_CONFIRM_FIXES more fixes before re-anchoring.
import {
  haversineM, RELOCATION_CONFIRM_FIXES, RELOCATION_CLUSTER_RADIUS_M, RELOCATION_MIN_SPAN_MS,
} from "@shared/geo";

interface Candidate {
  lat: number;
  lng: number;
  firstAt: number;
  lastAt: number;
  count: number;
}

const candidates = new Map<string, Candidate>(); // keyed by imei

/**
 * Record one accurate fix rejected only for its jump distance. Returns true
 * when it completes a consistent run and should be accepted as the new anchor
 * (the run is then cleared).
 */
export function recordJumpRejectedFix(imei: string, lat: number, lng: number, at: number): boolean {
  const prev = candidates.get(imei);
  const continues = prev !== undefined
    && at >= prev.lastAt
    && haversineM(prev.lat, prev.lng, lat, lng) <= RELOCATION_CLUSTER_RADIUS_M;
  const next: Candidate = continues
    ? { lat, lng, firstAt: prev.firstAt, lastAt: at, count: prev.count + 1 }
    : { lat, lng, firstAt: at, lastAt: at, count: 1 };
  if (next.count >= RELOCATION_CONFIRM_FIXES && next.lastAt - next.firstAt >= RELOCATION_MIN_SPAN_MS) {
    candidates.delete(imei);
    return true;
  }
  candidates.set(imei, next);
  return false;
}

/** Clear any partial run, e.g. after a normally accepted fix. */
export function resetRelocationCandidate(imei: string): void {
  candidates.delete(imei);
}

// Locks whose stored anchor just moved discontinuously (relocation re-anchor,
// or a poisoned out-of-service-area anchor healed by the first trusted fix).
// The gateway consumes the flag on that same report to recompute the bike's
// parking from the new position; otherwise parkingId stays whatever it was
// computed from the stale/poisoned position (BC-002, 2026-11-10).
const anchorRestored = new Set<string>();

export function markAnchorRestored(imei: string): void {
  anchorRestored.add(imei);
}

/** Returns true once per markAnchorRestored() call. */
export function consumeAnchorRestored(imei: string): boolean {
  return anchorRestored.delete(imei);
}

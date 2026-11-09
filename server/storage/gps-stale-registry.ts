// Confirmation window for the gps_stale dashboard alert (see
// GPS_STALE_CONFIRM_MS in shared/geo.ts). In-memory like theft-registry.ts:
// a restart only delays an alert by one confirmation window.
import { GPS_STALE_CONFIRM_MS } from "@shared/geo";

const firstSeen = new Map<string, number>(); // bikeId -> first sweep that saw it stale

/**
 * Feed the bike ids that are stale on this sweep; returns those that have been
 * stale continuously for at least GPS_STALE_CONFIRM_MS. Bikes absent from
 * `staleIds` (fix arrived, status changed, lock went quiet) are forgotten.
 */
export function confirmStaleGps(staleIds: readonly string[], now: number): string[] {
  const current = new Set(staleIds);
  for (const id of Array.from(firstSeen.keys())) {
    if (!current.has(id)) firstSeen.delete(id);
  }
  const confirmed: string[] = [];
  for (const id of Array.from(current)) {
    const since = firstSeen.get(id);
    if (since === undefined) {
      firstSeen.set(id, now);
    } else if (now - since >= GPS_STALE_CONFIRM_MS) {
      confirmed.push(id);
    }
  }
  return confirmed;
}

/** Test-only. */
export function resetStaleGpsRegistry(): void {
  firstSeen.clear();
}

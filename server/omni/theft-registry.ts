// Tracks consecutive OMNI "illegal movement" (alarm code=1) reports per lock,
// to auto-transition a bike to "lost" once the streak reaches the theft
// threshold (bike-status lifecycle spec, 2026-09: "6 отправок подряд без
// сброса = кража", confirmed the lock repeats code=1 on every report while
// the movement continues, unlike fall/code 2 which has an explicit "cleared"
// code 6 — illegal-movement has no such counterpart). The streak resets
// whenever ANY report for the same IMEI arrives that is NOT itself a
// code=1 alarm — i.e. the lock has stopped re-reporting movement, so
// whatever triggered it has stopped.
//
// Deliberately dependency-free (no Drizzle/storage imports) — mirrors
// pause-registry.ts/pending-end-registry.ts so it can be required from
// server/omni/store.ts without pulling in the full schema graph.

export const MOVEMENT_ALARM_THEFT_THRESHOLD = 6;

const streaks = new Map<string, number>(); // keyed by imei

/** Record one illegal-movement (code=1) alarm. Returns the new streak length for this lock. */
export function recordMovementAlarm(imei: string): number {
  const next = (streaks.get(imei) ?? 0) + 1;
  streaks.set(imei, next);
  return next;
}

/** Reset the streak — call for any report on this IMEI that is not itself a code=1 alarm. */
export function resetMovementAlarmStreak(imei: string): void {
  if (streaks.has(imei)) streaks.delete(imei);
}

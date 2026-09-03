// Tracks consecutive OMNI "illegal movement" (alarm code=1) OR "fall"
// (alarm code=2) reports per lock, to auto-transition a bike to "lost" once
// the combined streak reaches the theft threshold (bike-status lifecycle
// spec, 2026-09: "6 отправок подряд без сброса = кража"; amended 2026-09 to
// merge code=1 and code=2 into one shared streak). Originally this only
// counted code=1, on the assumption the lock repeats code=1 on every report
// while movement continues. In practice, mid-ride the lock's alarm code
// alternates between code=1 and code=2 report-to-report instead of holding
// steady, so counting code=1 alone let interleaved code=2 reports reset the
// streak every other report and made the 6-in-a-row threshold effectively
// unreachable. Both codes now feed the same counter. code=6 ("fall
// cleared") is intentionally inert for this streak — it neither increments
// nor resets it (see server/omni/store.ts's persistLockReport for the reset
// guard). The streak resets whenever ANY OTHER report for the same IMEI
// arrives — i.e. neither code=1, code=2, nor code=6 — meaning the lock has
// stopped re-reporting movement/fall, so whatever triggered it has stopped.
//
// Deliberately dependency-free (no Drizzle/storage imports) — mirrors
// pause-registry.ts/pending-end-registry.ts so it can be required from
// server/omni/store.ts without pulling in the full schema graph.

export const MOVEMENT_ALARM_THEFT_THRESHOLD = 6;

const streaks = new Map<string, number>(); // keyed by imei

/** Record one illegal-movement (code=1) or fall (code=2) alarm. Returns the new streak length for this lock. */
export function recordMovementAlarm(imei: string): number {
  const next = (streaks.get(imei) ?? 0) + 1;
  streaks.set(imei, next);
  return next;
}

/** Reset the streak — call for any report on this IMEI that is not itself a code=1/code=2 alarm (code=6 excluded — see header). */
export function resetMovementAlarmStreak(imei: string): void {
  if (streaks.has(imei)) streaks.delete(imei);
}

// Pure helpers for the multi-pause / cumulative free-grace model.
//
// Model: a ride may be paused and resumed any number of times. Every pause
// accrues into `totalPausedMs` (persisted). The first PAUSE_FREE_GRACE_MS of
// CUMULATIVE paused time across the whole ride pushes `paidUntilAt` back
// (free — the rider isn't billed for that time); any paused time beyond that
// cumulative budget no longer extends paidUntilAt, i.e. the paid-time clock
// keeps running even while the bike sits paused/locked.
//
// Both the server (resume/extend/endRide settlement) and the client (live
// ride-timer + live overage display) must agree on this arithmetic bit for
// bit, or the number the rider watches tick will jump when the server later
// settles it — so this file is the single source of truth, imported by both.
import { PAUSE_FREE_GRACE_MS } from "./geo";
import { computeOverage, type OverageResult } from "./billing";

/** The minimal ride shape this module needs — works with the full `Ride` too. */
export interface PausableRide {
  startedAt: number;
  paidUntilAt: number | null;
  pausedAt: number | null;
  totalPausedMs: number;
}

/**
 * Cumulative free-grace time "used up" as of `now`, capped at
 * PAUSE_FREE_GRACE_MS. Includes the free portion of an in-progress pause, so
 * it grows in real time while paused (until the cap), then stays flat.
 */
export function frozenSoFarMs(ride: PausableRide, now: number): number {
  const prior = Math.max(0, ride.totalPausedMs);
  if (ride.pausedAt == null) return Math.min(prior, PAUSE_FREE_GRACE_MS);
  const remaining = Math.max(0, PAUSE_FREE_GRACE_MS - prior);
  const freeThisPause = Math.min(Math.max(0, now - ride.pausedAt), remaining);
  return Math.min(prior + freeThisPause, PAUSE_FREE_GRACE_MS);
}

/**
 * How much of the CURRENT in-progress pause is still within the cumulative
 * free-grace budget, i.e. how much `paidUntilAt` should grow by if the ride
 * is resumed (or ended) right now. 0 when not paused.
 */
export function pendingPauseCreditMs(ride: PausableRide, now: number): number {
  if (ride.pausedAt == null) return 0;
  const remaining = Math.max(0, PAUSE_FREE_GRACE_MS - Math.max(0, ride.totalPausedMs));
  return Math.min(Math.max(0, now - ride.pausedAt), remaining);
}

/**
 * "В пути" display: actual riding time, excluding paused time up to the
 * cumulative free grace. Freezes while paused (until grace is exhausted),
 * then keeps ticking even while still paused once the grace is used up —
 * matching the model above 1:1.
 */
export function liveElapsedRidingMs(ride: PausableRide, now: number): number {
  // Deliberately always anchored on `now`, even while paused: frozenSoFarMs
  // grows in lockstep with `now` during a within-grace pause, cancelling out
  // wall-clock advance so the displayed value freezes exactly. Anchoring on
  // `pausedAt` instead (a past bug caught by shared/pause.test.ts) makes the
  // value drop the longer the pause lasts, which is wrong.
  return Math.max(0, (now - ride.startedAt) - frozenSoFarMs(ride, now));
}

/**
 * The paid-until instant as of `now`, folding in whatever free-grace credit
 * the current in-progress pause would contribute if resolved right now.
 * Single source of truth shared by computeLiveOverage and liveRemainingPaidMs
 * so the countdown display and the overage calculation never disagree about
 * where the paid window actually ends.
 */
export function effectivePaidUntilAt(ride: PausableRide, now: number): number {
  const basePaidUntilAt = ride.paidUntilAt ?? ride.startedAt;
  return basePaidUntilAt + pendingPauseCreditMs(ride, now);
}

/**
 * Live overage preview, consistent with what endRide will actually settle:
 * usedMs is raw wall-clock (endRide never subtracts paused time from it —
 * only paidUntilAt moves), paidMs reflects effectivePaidUntilAt.
 */
export function computeLiveOverage(ride: PausableRide, now: number): OverageResult {
  const usedMs = now - ride.startedAt;
  const paidMs = effectivePaidUntilAt(ride, now) - ride.startedAt;
  return computeOverage(usedMs, paidMs);
}

/**
 * "В пути" countdown display: remaining paid time, i.e. the exact complement
 * of liveElapsedRidingMs relative to the paid budget — freezes during a
 * within-grace pause and resumes counting down once grace is exhausted,
 * same as the elapsed timer freezes/resumes, since both anchor on the same
 * effectivePaidUntilAt. Never negative — overage is shown separately via
 * computeLiveOverage/LiveOverage, not as a negative countdown.
 */
export function liveRemainingPaidMs(ride: PausableRide, now: number): number {
  return Math.max(0, effectivePaidUntilAt(ride, now) - now);
}

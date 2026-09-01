// Pure billing helpers for the hourly prepaid model. Kept dependency-free and
// side-effect-free so they are trivially unit-testable and reusable on both the
// server (ride settlement) and — if needed — the client (cost previews).
//
// Money is represented in integer KOPECKS everywhere (1 ₽ = 100 kopecks) to
// avoid floating-point drift. Convert to rubles only at the display boundary.

import { OVERAGE_MINUTE_PRICE } from "./geo";

const MINUTE_MS = 60 * 1000;

// Price of one completed overage minute, in kopecks.
export function overageMinuteKopecks(): number {
  return Math.round(OVERAGE_MINUTE_PRICE * 100);
}

export interface OverageResult {
  // Whole COMPLETED extra minutes beyond the paid window (0 if within window
  // or if overtime hasn't run for a full minute yet).
  extraMinutes: number;
  // Additional charge for those extra minutes, in kopecks (0 if within window).
  overageKopecks: number;
}

// Compute the auto-extension (overage) for a ride under the per-minute
// post-paid-window model. The rider prepaid `paidMs` of riding time; if they
// used more, every COMPLETED extra minute costs one OVERAGE_MINUTE_PRICE —
// billed only once that minute has actually elapsed (at +60s, +120s, +180s
// of overtime, ...), never at the moment a new overage minute merely starts.
//
//   - paidMs <= 0        -> unknown/legacy tariff: no overage (settle as-is)
//   - usedMs <= paidMs   -> within the paid window: no overage
//   - usedMs  > paidMs   -> floor((usedMs - paidMs) / 1min) completed minutes charged
export function computeOverage(usedMs: number, paidMs: number): OverageResult {
  if (paidMs <= 0 || usedMs <= paidMs) {
    return { extraMinutes: 0, overageKopecks: 0 };
  }
  const extraMinutes = Math.floor((usedMs - paidMs) / MINUTE_MS);
  return { extraMinutes, overageKopecks: extraMinutes * overageMinuteKopecks() };
}

// Final ride cost in kopecks = prepaid base cost + any overage.
export function finalRideCost(baseCostKopecks: number, overageKopecks: number): number {
  return baseCostKopecks + overageKopecks;
}

// A compact human-facing ruble amount for payment confirmations. Keep the
// integer-kopek source of truth intact and omit only an all-zero fractional
// part: 15000 -> "150", 15050 -> "150.50".
export function formatKopecksAsRubles(kopecks: number): string {
  const sign = kopecks < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(kopecks));
  const rubles = Math.floor(absolute / 100);
  const kopekPart = absolute % 100;
  return kopekPart === 0
    ? `${sign}${rubles}`
    : `${sign}${rubles}.${String(kopekPart).padStart(2, "0")}`;
}

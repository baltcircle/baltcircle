// Pure billing helpers for the hourly prepaid model. Kept dependency-free and
// side-effect-free so they are trivially unit-testable and reusable on both the
// server (ride settlement) and — if needed — the client (cost previews).
//
// Money is represented in integer KOPECKS everywhere (1 ₽ = 100 kopecks) to
// avoid floating-point drift. Convert to rubles only at the display boundary.

import { OVERAGE_MINUTE_PRICE } from "./geo";

const MINUTE_MS = 60 * 1000;

// Price of one started overage minute, in kopecks.
export function overageMinuteKopecks(): number {
  return Math.round(OVERAGE_MINUTE_PRICE * 100);
}

export interface OverageResult {
  // Whole started extra minutes beyond the paid window (0 if within window).
  extraMinutes: number;
  // Additional charge for those extra minutes, in kopecks (0 if within window).
  overageKopecks: number;
}

// Compute the auto-extension (overage) for a ride under the per-minute
// post-paid-window model. The rider prepaid `paidMs` of riding time; if they
// used more, every STARTED extra minute costs one OVERAGE_MINUTE_PRICE.
//
//   - paidMs <= 0        -> unknown/legacy tariff: no overage (settle as-is)
//   - usedMs <= paidMs   -> within the paid window: no overage
//   - usedMs  > paidMs   -> ceil((usedMs - paidMs) / 1min) started minutes charged
export function computeOverage(usedMs: number, paidMs: number): OverageResult {
  if (paidMs <= 0 || usedMs <= paidMs) {
    return { extraMinutes: 0, overageKopecks: 0 };
  }
  const extraMinutes = Math.ceil((usedMs - paidMs) / MINUTE_MS);
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

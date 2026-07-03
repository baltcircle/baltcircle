// Pure billing helpers for the hourly prepaid model. Kept dependency-free and
// side-effect-free so they are trivially unit-testable and reusable on both the
// server (ride settlement) and — if needed — the client (cost previews).
//
// Money is represented in integer KOPECKS everywhere (1 ₽ = 100 kopecks) to
// avoid floating-point drift. Convert to rubles only at the display boundary.

import { OVERAGE_HOUR_PRICE } from "./geo";

const HOUR_MS = 60 * 60 * 1000;

// Price of one started overage hour, in kopecks.
export function overageHourKopecks(): number {
  return Math.round(OVERAGE_HOUR_PRICE * 100);
}

export interface OverageResult {
  // Whole started extra hours beyond the paid window (0 if within window).
  extraHours: number;
  // Additional charge for those extra hours, in kopecks (0 if within window).
  overageKopecks: number;
}

// Compute the auto-extension (overage) for a ride under the hourly prepaid
// model. The rider prepaid `paidMs` of riding time; if they used more, every
// STARTED extra hour costs one OVERAGE_HOUR_PRICE.
//
//   - paidMs <= 0        -> unknown/legacy tariff: no overage (settle as-is)
//   - usedMs <= paidMs   -> within the paid window: no overage
//   - usedMs  > paidMs   -> ceil((usedMs - paidMs) / 1h) started hours charged
export function computeOverage(usedMs: number, paidMs: number): OverageResult {
  if (paidMs <= 0 || usedMs <= paidMs) {
    return { extraHours: 0, overageKopecks: 0 };
  }
  const extraHours = Math.ceil((usedMs - paidMs) / HOUR_MS);
  return { extraHours, overageKopecks: extraHours * overageHourKopecks() };
}

// Final ride cost in kopecks = prepaid base cost + any overage.
export function finalRideCost(baseCostKopecks: number, overageKopecks: number): number {
  return baseCostKopecks + overageKopecks;
}

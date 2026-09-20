import type { QueryClient } from "@tanstack/react-query";

export const RIDER_PATHS = [
  "/api/bikes", "/api/parkings", "/api/map-objects", "/api/rides",
  "/api/rider/history", "/api/rider/stats", "/api/reservations/active",
  "/api/payment-methods", "/api/payments", "/api/wallet", "/api/support/chat",
  "/api/users/current",
];
export function isRiderQuery(key: readonly unknown[]) {
  return typeof key[0] === "string" && RIDER_PATHS.some((p) => key[0] === p || (key[0] as string).startsWith(`${p}/`));
}
export function refreshRiderData(qc: QueryClient) {
  return qc.invalidateQueries({ predicate: (q) => isRiderQuery(q.queryKey) });
}
type LifecycleRide = { id: number; status: string; [key: string]: unknown };
export function rideLifecycle(rides: LifecycleRide[]) {
  return JSON.stringify(rides.map((r) => [r.id, r.status, r.paidUntilAt, r.pausedAt, r.tariff, r.cost])
    .sort((a, b) => Number(a[0]) - Number(b[0])));
}
export function refreshRideDependents(qc: QueryClient) {
  for (const path of ["/api/rides", "/api/rider/history", "/api/rider/stats",
    "/api/reservations/active", "/api/bikes", "/api/wallet", "/api/payments"]) {
    void qc.invalidateQueries({ queryKey: [path] });
  }
}

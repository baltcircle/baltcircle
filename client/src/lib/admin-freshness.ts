import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { AdminTopic } from "@shared/admin-data";

export const ADMIN_POLL_MS = 20_000;
export const ANALYTICS_POLL_MS = 60_000;
const dependencies: Record<AdminTopic, string[]> = {
  fleet: ["/api/admin/bikes", "/api/bikes", "/api/admin/alerts", "/api/admin/parkings", "/api/parkings"],
  rides: ["/api/admin/rides", "/api/admin/ride-stats", "/api/rides", "/api/admin/users", "/api/admin/analytics"],
  users: ["/api/admin/users", "/api/admin/rides", "/api/admin/feedback", "/api/admin/analytics", "/api/admin/support"],
  feedback: ["/api/admin/feedback", "/api/admin/rides", "/api/admin/users", "/api/admin/analytics"],
  parkings: ["/api/admin/parkings", "/api/parkings", "/api/admin/analytics"],
  map: ["/api/admin/map-objects", "/api/map-objects"],
  service: ["/api/tickets", "/api/admin/bikes", "/api/bikes", "/api/admin/analytics"],
  support: ["/api/admin/support", "/api/admin/feedback", "/api/admin/analytics"],
};
const matches = (path: string, base: string) => path === base || path.startsWith(base + "/") || path.startsWith(base + "?");
export function isAdminDataKey(key: QueryKey): boolean {
  const path = String(key[0] ?? "");
  return path.startsWith("/api/admin/") || ["/api/tickets", "/api/bikes", "/api/parkings", "/api/map-objects", "/api/rides"]
    .some((base) => matches(path, base));
}
export function affectedByTopics(key: QueryKey, topics: AdminTopic[]): boolean {
  const path = String(key[0] ?? "");
  return topics.some((topic) => dependencies[topic]?.some((base) => matches(path, base)));
}
export function refreshAdminData(client: QueryClient, force = false) {
  return client.refetchQueries({
    type: "active",
    predicate: (q) => isAdminDataKey(q.queryKey) && (force || Date.now() - q.state.dataUpdatedAt >=
      (String(q.queryKey[0]).startsWith("/api/admin/analytics") ? ANALYTICS_POLL_MS : ADMIN_POLL_MS)),
  });
}

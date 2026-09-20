import type { AdminTopic } from "@shared/admin-data";

// No user data travels over the bus, only cache-invalidation topics. Read receipts
// are excluded to prevent GET-chat -> POST-read -> invalidate-chat feedback loops.
export function mutationTopics(method: string, path: string, status: number): AdminTopic[] {
  if (["GET", "HEAD", "OPTIONS"].includes(method) || /\/read\/?$/.test(path)) return [];
  const parkingArchive = method === "DELETE" && /^\/api\/admin\/parkings\/[^/]+$/.test(path) && status === 409;
  if (!parkingArchive && (status < 200 || status >= 300)) return [];
  if (/feedback/.test(path)) return ["feedback", "support"];
  if (/\/support\//.test(path)) return ["support"];
  if (/\/tickets(?:\/|$)/.test(path)) return ["service", "fleet"];
  if (/\/parkings(?:\/|$)/.test(path)) return ["parkings", "fleet"];
  if (/\/map-objects(?:\/|$)/.test(path)) return ["map"];
  if (/\/(?:rides|reservations|payments|tbank)(?:\/|$)/.test(path)) return ["rides", "fleet"];
  if (/\/(?:bikes|locks|alerts)(?:\/|$)/.test(path)) return ["fleet"];
  if (/\/(?:auth|users|account|profile)(?:\/|$)/.test(path)) return ["users"];
  return [];
}

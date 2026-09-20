export type AdminTopic = "fleet" | "rides" | "users" | "feedback" | "parkings" | "map" | "service" | "support";
export const ADMIN_TOPICS: AdminTopic[] = ["fleet", "rides", "users", "feedback", "parkings", "map", "service", "support"];
export interface AdminPageResult<T> {
  items: T[];
  total: number;
  counts?: Record<string, number>;
  categories?: string[];
}

export function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15 ? n : fallback;
}

export function parseAdminPage(query: Record<string, unknown>) {
  const integer = (v: unknown, fallback: number) => {
    if (typeof v !== "string" || !v.trim()) return fallback;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : fallback;
  };
  return {
    limit: Math.min(200, Math.max(1, integer(query.limit, 50))),
    offset: Math.min(2_147_483_647, Math.max(0, integer(query.offset, 0))),
    search: typeof query.search === "string" ? query.search.trim().slice(0, 200) : "",
  };
}

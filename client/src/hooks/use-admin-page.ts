import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/queryClient";
import type { AdminPageResult } from "@shared/admin-data";

export function useAdminPage<T>(path: string, filters: Record<string, string>) {
  const [requestedPage, setPage] = useState(0);
  const filterKey = JSON.stringify(filters);
  const [previousFilters, setPreviousFilters] = useState(filterKey);
  // Reset before querying, not in an effect which could request a stale offset.
  if (previousFilters !== filterKey) {
    setPreviousFilters(filterKey);
    setPage(0);
  }
  const page = previousFilters === filterKey ? requestedPage : 0;
  const query = useQuery<AdminPageResult<T>>({
    queryKey: [path, "page", { ...filters, page }],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ ...filters, limit: "50", offset: String(page * 50) });
      const res = await fetch(`${API_BASE}${path}/page?${params}`, { credentials: "include", signal });
      if (!res.ok) throw new Error(`${res.status}: Не удалось загрузить данные`);
      return res.json();
    },
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 50));
  // A deletion can remove the last page; clamp before committing an empty view.
  if (query.isSuccess && page >= pageCount) setPage(pageCount - 1);
  return { query, page, setPage, pageCount, total, pageItems: query.data?.items ?? [] };
}

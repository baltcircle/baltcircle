import { useQuery, useQueryClient } from "@tanstack/react-query";
import { appendLockTrack, type LockTrackPage, type LockTrackState } from "@shared/lock-track";
import { API_BASE } from "@/lib/queryClient";

// Per-ride React Query cache owns the cursor, including across slot changes.
// Cancellation prevents an old account/request from publishing a partial route.
const TRACK_POLL_MS = 15_000;

export function useRideTrackPoll(rideId: number | null | undefined) {
  const qc = useQueryClient();
  const queryKey = ["/api/rides", rideId, "lock-track"] as const;
  return useQuery<LockTrackState>({
    queryKey,
    queryFn: async ({ signal }) => {
      const previous = qc.getQueryData<LockTrackState>(queryKey);
      let cursor = previous?.nextCursor ?? 0;
      const pages: LockTrackPage[] = [];
      // Bounded requests; remaining pages resume on the next fast poll.
      for (let n = 0; n < 10; n++) {
        const res = await fetch(`${API_BASE}/api/rides/${rideId}/track?after=${cursor}`, {
          credentials: "include", signal,
        });
        if (!res.ok) throw new Error(`Track: ${res.status}`);
        const page = await res.json() as LockTrackPage;
        if (page.source !== "tracker" || !Array.isArray(page.items)
          || !Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor
          || (page.hasMore && page.nextCursor === cursor)) throw new Error("Invalid track page");
        pages.push(page);
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      return { ...appendLockTrack(previous, pages), hasMore: pages.at(-1)?.hasMore ?? false };
    },
    enabled: rideId != null,
    refetchInterval: (query) => rideId == null ? false
      : (query.state.data as (LockTrackState & { hasMore?: boolean }) | undefined)?.hasMore ? 250 : TRACK_POLL_MS,
    staleTime: 10_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    // A stale poll shouldn't wipe the last good track while a refetch is in
    // flight; react-query keeps the previous data by default between refetches.
  });
}

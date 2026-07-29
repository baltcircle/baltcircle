import { useQuery } from "@tanstack/react-query";
import type { MergedTrack } from "@shared/rideTrack";

// Poll the authoritative ride track during an active ride. The server prefers
// the bike's onboard tracker (which keeps reporting when the phone screen is
// locked) and falls back to the phone-fed track when no tracker is reporting.
// 15s cadence matches a typical tracker report interval — frequent enough to
// keep the drawn route fresh without hammering the endpoint.
const TRACK_POLL_MS = 15_000;

export function useRideTrackPoll(rideId: number | null | undefined) {
  return useQuery<MergedTrack>({
    queryKey: ["/api/rides", rideId, "track"],
    enabled: rideId != null,
    refetchInterval: rideId != null ? TRACK_POLL_MS : false,
    // A stale poll shouldn't wipe the last good track while a refetch is in
    // flight; react-query keeps the previous data by default between refetches.
  });
}

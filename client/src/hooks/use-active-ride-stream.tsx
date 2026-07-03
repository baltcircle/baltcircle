import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Ride } from "@shared/schema";
import { API_BASE } from "@/lib/queryClient";

export const ACTIVE_RIDE_KEY = ["/api/rides/active"] as const;
const BIKES_KEY = ["/api/bikes"] as const;

// Subscribes to the server's active-ride SSE stream and mirrors each pushed
// snapshot into the react-query cache under ACTIVE_RIDE_KEY. Pages keep reading
// useQuery(["/api/rides/active"]) unchanged — the data now arrives via push
// instead of a 4s poll, so one open EventSource replaces the request storm.
//
// EventSource sends the session cookie automatically (same-origin) and
// auto-reconnects on drop, so no manual retry/backoff is needed. On every
// pushed change we also invalidate the bikes list so the map reflects the
// bike's new position/status without polling /api/bikes either.
export function useActiveRideStream(): void {
  const qc = useQueryClient();

  useEffect(() => {
    // EventSource has no per-request auth header; the session travels on the
    // same-origin cookie. withCredentials keeps the cookie on cross-origin
    // dev setups where API_BASE points at another port.
    const url = `${API_BASE}/api/rides/active/stream`;
    const es = new EventSource(url, { withCredentials: true });

    es.onmessage = (ev) => {
      let ride: Ride | null = null;
      try {
        ride = JSON.parse(ev.data) as Ride | null;
      } catch {
        return; // ignore a malformed frame; the next event re-syncs
      }
      qc.setQueryData(ACTIVE_RIDE_KEY, ride);
      // A ride change moved/freed a bike → refresh the map's bike layer.
      qc.invalidateQueries({ queryKey: BIKES_KEY });
    };

    // On error the browser reconnects on its own; nothing to do but let the
    // cache hold the last known snapshot until the stream resumes.
    es.onerror = () => { /* auto-reconnect handled by EventSource */ };

    return () => es.close();
  }, [qc]);
}

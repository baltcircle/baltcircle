import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Ride } from "@shared/schema";
import { SSE_STALE_THRESHOLD_MS } from "@shared/geo";
import { API_BASE } from "@/lib/queryClient";
import { isStreamStale } from "./sse-watchdog";

export const ACTIVE_RIDE_KEY = ["/api/rides/active"] as const;
const BIKES_KEY = ["/api/bikes"] as const;

// How often the watchdog re-checks staleness. Comfortably under
// SSE_STALE_THRESHOLD_MS so detection latency stays close to the threshold
// itself rather than adding a second poll-sized delay on top of it.
const WATCHDOG_POLL_MS = 10 * 1000;

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
    let es: EventSource | null = null;
    let disposed = false;
    let lastActivityAt = Date.now();

    // EventSource has no per-request auth header; the session travels on the
    // same-origin cookie. withCredentials keeps the cookie on cross-origin
    // dev setups where API_BASE points at another port.
    const connect = () => {
      if (disposed) return;
      lastActivityAt = Date.now();
      const url = `${API_BASE}/api/rides/active/stream`;
      const next = new EventSource(url, { withCredentials: true });

      next.onmessage = (ev) => {
        lastActivityAt = Date.now();
        let ride: Ride | null;
        try {
          ride = JSON.parse(ev.data) as Ride | null;
        } catch {
          return; // ignore a malformed frame; the next event re-syncs
        }
        qc.setQueryData(ACTIVE_RIDE_KEY, ride);
        // A ride change moved/freed a bike → refresh the map's bike layer.
        qc.invalidateQueries({ queryKey: BIKES_KEY });
      };

      // Named heartbeat event pushed every SSE_HEARTBEAT_INTERVAL_MS by the
      // server (server/http/rides.ts). No payload we act on — it only proves
      // the connection is alive end-to-end, feeding the watchdog below.
      next.addEventListener("heartbeat", () => { lastActivityAt = Date.now(); });

      // On error the browser reconnects on its own; nothing to do but let the
      // cache hold the last known snapshot until the stream resumes.
      next.onerror = () => { /* auto-reconnect handled by EventSource */ };

      es = next;
    };

    const reconnect = () => {
      if (disposed) return;
      es?.close();
      connect();
    };

    // Fast-path triggers: cheap, and cover the common cases (tab refocused,
    // network back after an explicit offline period). Not sufficient alone —
    // see the watchdog below — since some browsers/OSes don't reliably fire
    // these for every backgrounding/roaming transition.
    const onVisibility = () => {
      if (document.visibilityState === "visible") reconnect();
    };
    const onOnline = () => reconnect();

    // Deterministic backstop: mobile OS/carrier NAT can kill an idle TCP
    // session without ever firing EventSource's onerror or the browser's
    // online/offline events — the tab stays foregrounded and "online" the
    // whole time while the connection is actually dead. If neither a
    // heartbeat nor real ride data has arrived within SSE_STALE_THRESHOLD_MS,
    // treat the connection as dead and reconnect regardless of what the
    // browser reports.
    const watchdog = setInterval(() => {
      if (isStreamStale(lastActivityAt, Date.now(), SSE_STALE_THRESHOLD_MS)) reconnect();
    }, WATCHDOG_POLL_MS);

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);

    return () => {
      disposed = true;
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      es?.close();
    };
  }, [qc]);
}

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Ride } from "@shared/schema";
import { SSE_STALE_THRESHOLD_MS } from "@shared/geo";
import { API_BASE, getSessionGeneration, markActiveRideSnapshot } from "@/lib/queryClient";
import { useCurrentUser } from "./use-current-user";
import { rideLifecycle, refreshRideDependents } from "@/lib/rider-freshness";
import { isStreamStale } from "./sse-watchdog";

export const ACTIVE_RIDE_KEY = ["/api/rides/active"] as const;

// How often the watchdog re-checks staleness. Comfortably under
// SSE_STALE_THRESHOLD_MS so detection latency stays close to the threshold
// itself rather than adding a second poll-sized delay on top of it.
const WATCHDOG_POLL_MS = 10 * 1000;

// One account-bound stream is mounted by MapPage. HTTP polling is an independent
// fallback. Lifecycle invalidation also observes HTTP/mutation writes, and does
// not refresh history on every track point.
export function useActiveRideStream(): void {
  const qc = useQueryClient();
  const { user } = useCurrentUser();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;
    const generation = getSessionGeneration();
    let lifecycle: string | undefined;
    let disposed = false;
    // Includes HTTP fallback and local mutation updates, not just SSE events.
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== ACTIVE_RIDE_KEY[0] || event.type !== "updated") return;
      const rides = event.query.state.data as Ride[] | undefined;
      if (!rides || disposed || generation !== getSessionGeneration()) return;
      const next = rideLifecycle(rides);
      if (lifecycle !== next) {
        lifecycle = next;
        refreshRideDependents(qc);
      }
    });
    let es: EventSource | null = null;
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
        if (disposed || es !== next || generation !== getSessionGeneration()) return;
        lastActivityAt = Date.now();
        let rides: Ride[];
        try {
          rides = JSON.parse(ev.data) as Ride[];
        } catch {
          return; // ignore a malformed frame; the next event re-syncs
        }
        if (!Array.isArray(rides)) return;
        markActiveRideSnapshot();
        // Cancel older HTTP snapshots before publishing the newer stream state.
        void qc.cancelQueries({ queryKey: ACTIVE_RIDE_KEY });
        qc.setQueryData(ACTIVE_RIDE_KEY, rides);
      };

      // Named heartbeat event pushed every SSE_HEARTBEAT_INTERVAL_MS by the
      // server (server/http/rides.ts). No payload we act on — it only proves
      // the connection is alive end-to-end, feeding the watchdog below.
      next.addEventListener("heartbeat", () => {
        if (!disposed && es === next) lastActivityAt = Date.now();
      });

      // On error the browser reconnects on its own; nothing to do but let the
      // cache hold the last known snapshot until the stream resumes.
      next.onerror = () => { if (es === next) markActiveRideSnapshot(0); };

      es = next;
    };

    const reconnect = () => {
      if (disposed) return;
      markActiveRideSnapshot(0);
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
      markActiveRideSnapshot(0);
      unsubscribe();
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      es?.close();
    };
  }, [qc, userId]);
}

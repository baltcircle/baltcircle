import { useEffect } from "react";
import { API_BASE, queryClient } from "@/lib/queryClient";
import { openLiveStream } from "@/lib/live-stream";

let dispose: (() => void) | undefined;
let subscribers = 0;
const invalidate = (...paths: string[]) => {
  for (const path of paths) void queryClient.invalidateQueries({ queryKey: [path] });
};
const fleet = () => invalidate("/api/bikes", "/api/parkings", "/api/reservations/active",
  "/api/admin/bikes", "/api/admin/rides", "/api/admin/ride-stats", "/api/admin/parkings", "/api/admin/alerts");
const catalog = () => invalidate("/api/map-objects", "/api/parkings");

export function useFleetStream() {
  useEffect(() => {
    subscribers += 1;
    if (!dispose) {
      dispose = openLiveStream(`${API_BASE}/api/bikes/stream`, {
        message: fleet, catalog, telemetry: () => invalidate("/api/bikes"),
      }, () => { fleet(); catalog(); });
    }
    return () => {
      if (--subscribers === 0) { dispose?.(); dispose = undefined; }
    };
  }, []);
}

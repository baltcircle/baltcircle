import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { rideLifecycle, refreshRiderData } from "./rider-freshness";

describe("rider reconciliation", () => {
  it("ignores GPS changes, but detects start, end and extension", () => {
    const ride = { id: 4, status: "active", paidUntilAt: 100 };
    expect(rideLifecycle([ride])).toBe(rideLifecycle([{ ...ride, distanceM: 20, track: [1] }]));
    expect(rideLifecycle([ride])).not.toBe(rideLifecycle([]));
    expect(rideLifecycle([ride])).not.toBe(rideLifecycle([{ ...ride, paidUntilAt: 200 }]));
    expect(rideLifecycle([ride, { ...ride, id: 5 }])).toBe(rideLifecycle([{ ...ride, id: 5 }, ride]));
  });
  it("invalidates rider data without touching unrelated/admin queries", async () => {
    const qc = new QueryClient();
    for (const path of ["/api/rides", "/api/rider/history", "/api/rider/stats",
      "/api/reservations/active", "/api/map-objects", "/api/admin/users"]) qc.setQueryData([path], []);
    await refreshRiderData(qc);
    expect(qc.getQueryState(["/api/rider/history"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["/api/rider/stats"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["/api/map-objects"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["/api/admin/users"])?.isInvalidated).toBe(false);
    qc.clear();
  });
});

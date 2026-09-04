import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/MapPage.tsx"), "utf8");

// Regression test for the bug where the post-ride rating dialog stopped
// appearing: most rides end via the async "закройте замок" flow, where the
// server first replies with {status: "awaiting_lock_close"} (no ride id
// usable at that point) and only later — once the physical lock confirms
// closure — removes the ride from the active-rides list over SSE.
// setFeedbackRideId(data.id) in endMut.onSuccess only covers the
// synchronous-completion branch, so it was never called for the (dominant)
// async path. The fix threads the id through a ref set in onMutate and
// consumed once the ride actually disappears from activeRides.
//
// Two simultaneous rides made this array-membership-based (not
// activeRide === null), since ending one ride must not be masked by the
// other ride still being active.
describe("MapPage post-ride feedback dialog", () => {
  it("captures the ending ride's id in onMutate before the server responds", () => {
    expect(source).toContain("const pendingEndRideId = useRef<number | null>(null);");
    expect(source).toMatch(/onMutate:\s*\(rideId\)\s*=>\s*\{\s*pendingEndRideId\.current = rideId;/);
  });

  it("opens the feedback dialog once the pending ride id disappears from activeRides, using the ref value", () => {
    expect(source).toMatch(
      /if \(!activeRides\.some\(\(r\) => r\.id === pendingId\)\) \{[\s\S]{0,1500}setFeedbackRideId\(pendingId\);/,
    );
  });

  it("clears the pending ref once the dialog id has been consumed or a new end starts", () => {
    // Consumed by the activeRides-membership effect...
    expect(source).toMatch(/setFeedbackRideId\(pendingId\);\s*pendingEndRideId\.current = null;/);
    // ...and also cleared on the synchronous-completion branch, which opens
    // the dialog directly via data.id instead.
    expect(source).toMatch(/pendingEndRideId\.current = null;\s*setFeedbackRideId\(data\.id\);/);
  });
});

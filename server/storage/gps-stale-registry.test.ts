import { beforeEach, describe, expect, it } from "vitest";
import { GPS_STALE_CONFIRM_MS } from "@shared/geo";
import { confirmStaleGps, resetStaleGpsRegistry } from "./gps-stale-registry";

beforeEach(() => resetStaleGpsRegistry());

describe("confirmStaleGps", () => {
  it("does not confirm on the first sighting", () => {
    expect(confirmStaleGps(["BC-002"], 0)).toEqual([]);
  });

  it("confirms once stale continuously for the window", () => {
    confirmStaleGps(["BC-002"], 0);
    expect(confirmStaleGps(["BC-002"], GPS_STALE_CONFIRM_MS - 1)).toEqual([]);
    expect(confirmStaleGps(["BC-002"], GPS_STALE_CONFIRM_MS)).toEqual(["BC-002"]);
  });

  it("restarts the window when the bike recovers in between", () => {
    confirmStaleGps(["BC-002"], 0);
    confirmStaleGps([], 60_000);
    expect(confirmStaleGps(["BC-002"], GPS_STALE_CONFIRM_MS)).toEqual([]);
    expect(confirmStaleGps(["BC-002"], 2 * GPS_STALE_CONFIRM_MS - 1)).toEqual([]);
    expect(confirmStaleGps(["BC-002"], 2 * GPS_STALE_CONFIRM_MS)).toEqual(["BC-002"]);
  });

  it("tracks bikes independently", () => {
    confirmStaleGps(["A"], 0);
    confirmStaleGps(["A", "B"], 120_000);
    expect(confirmStaleGps(["A", "B"], GPS_STALE_CONFIRM_MS)).toEqual(["A"]);
  });
});

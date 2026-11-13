import { describe, expect, it } from "vitest";
import { MAX_GPS_CLOCK_AHEAD_MS, MAX_GPS_CLOCK_BEHIND_MS, trustedDeviceTimestamp } from "./geo";

const NOW = 1_794_000_000_000;

describe("trustedDeviceTimestamp", () => {
  it("keeps a plausible device time", () => {
    expect(trustedDeviceTimestamp(NOW - 5_000, NOW)).toBe(NOW - 5_000);
    expect(trustedDeviceTimestamp(NOW + MAX_GPS_CLOCK_AHEAD_MS, NOW)).toBe(NOW + MAX_GPS_CLOCK_AHEAD_MS);
    expect(trustedDeviceTimestamp(NOW - MAX_GPS_CLOCK_BEHIND_MS, NOW)).toBe(NOW - MAX_GPS_CLOCK_BEHIND_MS);
  });

  it("falls back to receipt time for a clock running ahead (spoofed GNSS, ~6h)", () => {
    expect(trustedDeviceTimestamp(NOW + 6 * 3600_000, NOW)).toBe(NOW);
    expect(trustedDeviceTimestamp(NOW + MAX_GPS_CLOCK_AHEAD_MS + 1, NOW)).toBe(NOW);
  });

  it("falls back to receipt time for a clock far in the past (unset almanac, 1970/2000)", () => {
    expect(trustedDeviceTimestamp(0, NOW)).toBe(NOW);
    expect(trustedDeviceTimestamp(NOW - MAX_GPS_CLOCK_BEHIND_MS - 1, NOW)).toBe(NOW);
  });

  it("falls back for missing or non-finite values", () => {
    expect(trustedDeviceTimestamp(null, NOW)).toBe(NOW);
    expect(trustedDeviceTimestamp(undefined, NOW)).toBe(NOW);
    expect(trustedDeviceTimestamp(Number.NaN, NOW)).toBe(NOW);
    expect(trustedDeviceTimestamp(Number.POSITIVE_INFINITY, NOW)).toBe(NOW);
  });
});

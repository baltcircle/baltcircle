import { describe, it, expect } from "vitest";
import {
  chooseTrackSource,
  interpolateSparse,
  mergeRideTrack,
  type TrackPoint,
} from "./rideTrack";

describe("chooseTrackSource", () => {
  const phone: TrackPoint[] = [
    [0, 0, 1000],
    [1, 1, 2000],
  ];

  it("prefers the tracker when it has at least two points", () => {
    const tracker: TrackPoint[] = [
      [10, 10, 1000],
      [11, 11, 2000],
    ];
    const r = chooseTrackSource(tracker, phone);
    expect(r.source).toBe("tracker");
    expect(r.points).toBe(tracker);
  });

  it("falls back to phone when the tracker has no points", () => {
    const r = chooseTrackSource([], phone);
    expect(r.source).toBe("phone");
    expect(r.points).toBe(phone);
  });

  it("falls back to phone when the tracker has a single ping (no line)", () => {
    const r = chooseTrackSource([[5, 5, 1000]], phone);
    expect(r.source).toBe("phone");
  });
});

describe("interpolateSparse", () => {
  it("returns the input unchanged when there are fewer than two points", () => {
    expect(interpolateSparse([])).toEqual([]);
    expect(interpolateSparse([[1, 2, 3]])).toEqual([[1, 2, 3]]);
  });

  it("inserts evenly spaced midpoints across a continuous sparse gap", () => {
    // 40s apart, step 10s → expect points at 10s/20s/30s inserted between.
    const pts: TrackPoint[] = [
      [0, 0, 0],
      [40, 80, 40_000],
    ];
    const out = interpolateSparse(pts, 10_000, 45_000);
    expect(out.map((p) => p[2])).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
    // Linear on both axes.
    expect(out[1]).toEqual([10, 20, 10_000]);
    expect(out[2]).toEqual([20, 40, 20_000]);
    expect(out[3]).toEqual([30, 60, 30_000]);
  });

  it("does NOT interpolate across a real gap (> maxGapMs) so segmentTrack can break it", () => {
    const pts: TrackPoint[] = [
      [0, 0, 0],
      [10, 10, 120_000], // 2 min gap = signal loss
    ];
    const out = interpolateSparse(pts, 10_000, 45_000);
    expect(out).toEqual(pts);
  });

  it("leaves already-dense samples untouched", () => {
    const pts: TrackPoint[] = [
      [0, 0, 0],
      [1, 1, 5_000],
      [2, 2, 10_000],
    ];
    expect(interpolateSparse(pts, 10_000, 45_000)).toEqual(pts);
  });
});

describe("mergeRideTrack", () => {
  it("densifies tracker output when tracker is authoritative", () => {
    const tracker: TrackPoint[] = [
      [0, 0, 0],
      [40, 40, 40_000],
    ];
    const r = mergeRideTrack({ tracker, phone: [], stepMs: 10_000, maxGapMs: 45_000 });
    expect(r.source).toBe("tracker");
    expect(r.points.length).toBeGreaterThan(tracker.length);
  });

  it("returns the phone track verbatim when tracker is unavailable", () => {
    const phone: TrackPoint[] = [
      [0, 0, 0],
      [1, 1, 3_000],
    ];
    const r = mergeRideTrack({ tracker: [], phone });
    expect(r.source).toBe("phone");
    expect(r.points).toBe(phone);
  });
});

import { describe, expect, it } from "vitest";
import { SSE_HEARTBEAT_INTERVAL_MS, SSE_STALE_THRESHOLD_MS } from "@shared/geo";
import { isStreamStale } from "./sse-watchdog";

describe("SSE active-ride stream watchdog", () => {
  it("is not stale right after activity", () => {
    const now = Date.now();
    expect(isStreamStale(now, now, SSE_STALE_THRESHOLD_MS)).toBe(false);
    expect(isStreamStale(now - 1000, now, SSE_STALE_THRESHOLD_MS)).toBe(false);
  });

  it("is not stale exactly at the threshold boundary", () => {
    const now = Date.now();
    expect(isStreamStale(now - SSE_STALE_THRESHOLD_MS, now, SSE_STALE_THRESHOLD_MS)).toBe(false);
  });

  it("is stale once strictly past the threshold", () => {
    const now = Date.now();
    expect(isStreamStale(now - SSE_STALE_THRESHOLD_MS - 1, now, SSE_STALE_THRESHOLD_MS)).toBe(true);
  });

  it("keeps enough margin above the server heartbeat cadence to avoid false-triggering on a normal tick", () => {
    // If the threshold ever drifted below the heartbeat interval, the
    // watchdog would force-reconnect a perfectly healthy connection on every
    // single heartbeat cycle.
    expect(SSE_STALE_THRESHOLD_MS).toBeGreaterThan(SSE_HEARTBEAT_INTERVAL_MS * 1.5);
  });
});

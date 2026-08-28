// Production incident, 2026-08-27: an OMNI lock reports physical closure
// exactly ONCE per "завершить" request. Before this fix, server/storage.ts's
// LOCK_CLOSED_FOR_END bridge called storage.endRide() a single time and
// swallowed the error — a rider whose lock GPS was momentarily stale at the
// exact moment of closure had no way to self-recover (their own manual
// retry hits the identical fast path and gets the identical error). This
// file pins settleEndWithRetry's bounded-retry behaviour: keep trying only
// while the error is the exact transient stale-GPS gate, stop immediately
// on any other error or a successful/no-op settlement, and give up once the
// retry window elapses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ transaction: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
const sendToUserAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: sendToUserAsyncMock }));

import { storage } from "./storage";
import { pendingEndEvents, LOCK_CLOSED_FOR_END } from "./storage/events";
import {
  END_SETTLE_RETRY_INTERVAL_MS,
  END_SETTLE_RETRY_WINDOW_MS,
  RIDE_END_AWAITING_LOCK_GPS_ERROR,
} from "@shared/geo";

const PAYLOAD = { rideId: 42, userId: "user-1", imei: "861234567890123" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// Lets any already-queued microtasks (the .then chain inside
// settleEndWithRetry) settle before we inspect mock call counts or advance
// timers again.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("pending-end settle-with-retry bridge", () => {
  it("retries on the exact stale-GPS error and stops once it settles", async () => {
    const endRideSpy = vi.spyOn(storage, "endRide")
      .mockResolvedValueOnce({ error: RIDE_END_AWAITING_LOCK_GPS_ERROR } as any)
      .mockResolvedValueOnce({ error: RIDE_END_AWAITING_LOCK_GPS_ERROR } as any)
      .mockResolvedValueOnce({ id: 42, status: "completed" } as any);

    pendingEndEvents.emit(LOCK_CLOSED_FOR_END, PAYLOAD);
    await flush();
    expect(endRideSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(END_SETTLE_RETRY_INTERVAL_MS);
    expect(endRideSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(END_SETTLE_RETRY_INTERVAL_MS);
    expect(endRideSpy).toHaveBeenCalledTimes(3);

    // No further timer should be armed after a successful settlement.
    await vi.advanceTimersByTimeAsync(END_SETTLE_RETRY_WINDOW_MS);
    expect(endRideSpy).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error (e.g. outside any parking zone)", async () => {
    const endRideSpy = vi.spyOn(storage, "endRide")
      .mockResolvedValueOnce({ error: "Велосипед сейчас не в зоне парковки — завершить поездку нельзя. Переместите велосипед в парковочную зону." } as any);

    pendingEndEvents.emit(LOCK_CLOSED_FOR_END, PAYLOAD);
    await flush();
    expect(endRideSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(END_SETTLE_RETRY_WINDOW_MS);
    expect(endRideSpy).toHaveBeenCalledTimes(1);
  });

  it("does not retry once the ride is no longer active (undefined = already settled/cancelled elsewhere)", async () => {
    const endRideSpy = vi.spyOn(storage, "endRide").mockResolvedValueOnce(undefined as any);

    pendingEndEvents.emit(LOCK_CLOSED_FOR_END, PAYLOAD);
    await flush();
    expect(endRideSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(END_SETTLE_RETRY_WINDOW_MS);
    expect(endRideSpy).toHaveBeenCalledTimes(1);
  });

  it("gives up once the retry window elapses, even if the GPS gate never clears", async () => {
    const endRideSpy = vi.spyOn(storage, "endRide")
      .mockResolvedValue({ error: RIDE_END_AWAITING_LOCK_GPS_ERROR } as any);

    pendingEndEvents.emit(LOCK_CLOSED_FOR_END, PAYLOAD);
    await flush();

    // Drain the whole window in interval-sized steps, flushing microtasks
    // between each so the recursive setTimeout chain keeps advancing.
    const steps = Math.ceil(END_SETTLE_RETRY_WINDOW_MS / END_SETTLE_RETRY_INTERVAL_MS) + 2;
    for (let i = 0; i < steps; i++) {
      await vi.advanceTimersByTimeAsync(END_SETTLE_RETRY_INTERVAL_MS);
    }

    const callsAtGiveUp = endRideSpy.mock.calls.length;
    expect(callsAtGiveUp).toBeGreaterThan(1); // it did retry multiple times
    expect(callsAtGiveUp).toBeLessThan(steps + 2); // but eventually stopped, not runaway

    // Further time passing must not schedule any more attempts.
    await vi.advanceTimersByTimeAsync(END_SETTLE_RETRY_WINDOW_MS);
    expect(endRideSpy).toHaveBeenCalledTimes(callsAtGiveUp);
  });
});

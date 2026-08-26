import { beforeEach, describe, expect, it, vi } from "vitest";

// purgeOldTelemetry deletes stale bike_telemetry rows in batches via raw SQL
// (the table is queried with raw sql elsewhere too — see server/storage/ride.ts).
// Covers: cutoff math, batch looping until a short batch signals "caught up",
// the maxBatches safety cap, and the zero-backlog no-op case.

const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({ db: {}, pool: poolMock, bootstrapReady: Promise.resolve() }));

import { storage } from "./storage";

beforeEach(() => {
  poolMock.query.mockReset();
});

describe("purgeOldTelemetry", () => {
  it("does nothing when there is no backlog", async () => {
    poolMock.query.mockResolvedValueOnce({ rowCount: 0 });
    const deleted = await storage.purgeOldTelemetry();
    expect(deleted).toBe(0);
    expect(poolMock.query).toHaveBeenCalledTimes(1);
  });

  it("stops after the first short batch (caught up)", async () => {
    poolMock.query.mockResolvedValueOnce({ rowCount: 1200 }); // < default batchSize 2000
    const deleted = await storage.purgeOldTelemetry();
    expect(deleted).toBe(1200);
    expect(poolMock.query).toHaveBeenCalledTimes(1);
  });

  it("loops across full batches and sums the total", async () => {
    poolMock.query
      .mockResolvedValueOnce({ rowCount: 2000 })
      .mockResolvedValueOnce({ rowCount: 2000 })
      .mockResolvedValueOnce({ rowCount: 500 }); // short -> stop
    const deleted = await storage.purgeOldTelemetry();
    expect(deleted).toBe(4500);
    expect(poolMock.query).toHaveBeenCalledTimes(3);
  });

  it("never exceeds maxBatches even if every batch stays full", async () => {
    poolMock.query.mockResolvedValue({ rowCount: 2000 }); // always full
    const deleted = await storage.purgeOldTelemetry({ maxBatches: 3, batchSize: 2000 });
    expect(deleted).toBe(6000);
    expect(poolMock.query).toHaveBeenCalledTimes(3);
  });

  it("passes the cutoff timestamp and batch size as query params", async () => {
    const before = Date.now();
    poolMock.query.mockResolvedValueOnce({ rowCount: 0 });
    await storage.purgeOldTelemetry({ batchSize: 777 });
    const [sql, params] = poolMock.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM bike_telemetry/);
    expect(params[1]).toBe(777);
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    expect(params[0]).toBeLessThanOrEqual(before - THIRTY_DAYS_MS + 1000);
    expect(params[0]).toBeGreaterThanOrEqual(before - THIRTY_DAYS_MS - 5000);
  });
});

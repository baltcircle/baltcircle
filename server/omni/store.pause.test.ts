// Covers the pause-registry integration inside persistLockReport's
// "lockReport" case: an armed pause must be consumed and turned into the
// ride's `paused_at`, and — crucially — must NOT also fall through to the
// F-04 "unexpected physical lock closure" anomaly flag, since that closure
// was expected (the rider was told to close the lock to start the pause).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OmniMessage } from "@shared/omni/protocol";

const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
const consumePendingPauseMock = vi.hoisted(() => vi.fn());
const rideEventsEmitMock = vi.hoisted(() => vi.fn());

vi.mock("../db/bootstrap", () => ({
  pool: poolMock,
  db: {},
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./pause-registry", () => ({
  consumePendingPause: consumePendingPauseMock,
  registerPendingPause: vi.fn(),
  clearPendingPause: vi.fn(),
  hasPendingPause: vi.fn(),
}));
vi.mock("../storage/events", () => ({
  rideEvents: { emit: rideEventsEmitMock },
}));

import { PgOmniStore } from "./store";

const IMEI = "861234567890123";
const AT = 1_755_000_000_000;
const store = new PgOmniStore();

function lockReportMessage(): OmniMessage {
  return { type: "lockReport", userId: "user-1", at: AT, rideMinutes: 12 } as OmniMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("persistLockReport lockReport case — pause-registry integration", () => {
  it("consumes an armed pause and marks the ride paused, without touching physically_locked_at", async () => {
    consumePendingPauseMock.mockReturnValue({ rideId: 7, userId: "user-1" });
    poolMock.query.mockImplementation((sql: string) => {
      if (sql.includes("UPDATE rides SET paused_at")) {
        return Promise.resolve({ rows: [{ user_id: "user-1" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await store.persistLockReport(IMEI, lockReportMessage(), AT);

    expect(consumePendingPauseMock).toHaveBeenCalledWith(IMEI);
    const pauseCall = poolMock.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE rides SET paused_at"));
    expect(pauseCall).toBeTruthy();
    expect(pauseCall![1]).toEqual([AT, 7]);
    expect(rideEventsEmitMock).toHaveBeenCalledWith("user-1", "point");
    // F-04 anomaly bookkeeping must be skipped entirely on the consumed path.
    expect(poolMock.query.mock.calls.some(([sql]) => String(sql).includes("physically_locked_at"))).toBe(false);
  });

  it("falls through to the F-04 anomaly flag when the armed pause's ride is no longer active", async () => {
    consumePendingPauseMock.mockReturnValue({ rideId: 7, userId: "user-1" });
    poolMock.query.mockImplementation((sql: string) => {
      if (sql.includes("UPDATE rides SET paused_at")) {
        return Promise.resolve({ rows: [] }); // ride ended in the meantime
      }
      if (sql.startsWith("SELECT bike_id FROM locks")) {
        return Promise.resolve({ rows: [{ bike_id: "BC-01" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await store.persistLockReport(IMEI, lockReportMessage(), AT);

    expect(rideEventsEmitMock).not.toHaveBeenCalled();
    expect(poolMock.query.mock.calls.some(([sql]) => String(sql).includes("physically_locked_at"))).toBe(true);
  });

  it("applies the ordinary F-04 anomaly flag when there is no armed pause at all", async () => {
    consumePendingPauseMock.mockReturnValue(null);
    poolMock.query.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT bike_id FROM locks")) {
        return Promise.resolve({ rows: [{ bike_id: "BC-01" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await store.persistLockReport(IMEI, lockReportMessage(), AT);

    expect(poolMock.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE rides SET paused_at"))).toBe(false);
    expect(poolMock.query.mock.calls.some(([sql]) => String(sql).includes("physically_locked_at"))).toBe(true);
  });
});

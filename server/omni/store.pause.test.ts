// Covers the pause-registry integration inside persistLockReport's
// "lockReport" case: an armed pause must be consumed and turned into the
// ride's `paused_at`, and — crucially — must NOT also fall through to the
// auto-pause/F-04 branch below, since that closure was expected (the rider
// was told to close the lock to start the pause).
//
// Also covers the auto-pause branch itself: when NOTHING was armed (no
// requestPauseRide/requestEndRide tap preceded this closure) and the ride is
// still active, the lock closure must atomically set both `paused_at` and
// `physically_locked_at` in one UPDATE — this is what lets a rider who just
// closed the lock without tapping "Пауза" get back in via "Продолжить"
// instead of being stranded (the deadlock this feature fixes).
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

// The auto-pause/F-04 fallthrough query is a single combined UPDATE that sets
// both physically_locked_at and paused_at — distinguish it from the armed-
// pause branch's UPDATE (which only ever touches paused_at) by requiring both
// column names in the SQL text.
function isAutoPauseUpdate(sql: string): boolean {
  return sql.includes("UPDATE rides SET") && sql.includes("physically_locked_at") && sql.includes("paused_at");
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
    // Auto-pause/F-04 bookkeeping must be skipped entirely on the consumed path.
    expect(poolMock.query.mock.calls.some(([sql]) => isAutoPauseUpdate(String(sql)))).toBe(false);
  });

  it("falls through to the auto-pause branch when the armed pause's ride is no longer active", async () => {
    consumePendingPauseMock.mockReturnValue({ rideId: 7, userId: "user-1" });
    poolMock.query.mockImplementation((sql: string) => {
      if (sql.includes("UPDATE rides SET paused_at")) {
        return Promise.resolve({ rows: [] }); // ride ended in the meantime
      }
      if (sql.startsWith("SELECT bike_id FROM locks")) {
        return Promise.resolve({ rows: [{ bike_id: "BC-01" }] });
      }
      if (isAutoPauseUpdate(sql)) {
        return Promise.resolve({ rows: [] }); // still no longer active -> no-op
      }
      return Promise.resolve({ rows: [] });
    });

    await store.persistLockReport(IMEI, lockReportMessage(), AT);

    expect(rideEventsEmitMock).not.toHaveBeenCalled();
    expect(poolMock.query.mock.calls.some(([sql]) => isAutoPauseUpdate(String(sql)))).toBe(true);
  });

  it("auto-pauses the ride when the lock is closed with nothing armed at all (the deadlock fix)", async () => {
    consumePendingPauseMock.mockReturnValue(null);
    poolMock.query.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT bike_id FROM locks")) {
        return Promise.resolve({ rows: [{ bike_id: "BC-01" }] });
      }
      if (isAutoPauseUpdate(sql)) {
        return Promise.resolve({ rows: [{ id: 7, user_id: "user-1" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await store.persistLockReport(IMEI, lockReportMessage(), AT);

    expect(poolMock.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE rides SET paused_at"))).toBe(false);
    const autoPauseCall = poolMock.query.mock.calls.find(([sql]) => isAutoPauseUpdate(String(sql)));
    expect(autoPauseCall).toBeTruthy();
    expect(autoPauseCall![1]).toEqual([AT, "BC-01"]);
    // Combined UPDATE sets both flags together and must emit like a real pause.
    expect(rideEventsEmitMock).toHaveBeenCalledWith("user-1", "point");
  });

  it("is idempotent for a retransmitted closure report once the ride is already auto-paused", async () => {
    consumePendingPauseMock.mockReturnValue(null);
    poolMock.query.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT bike_id FROM locks")) {
        return Promise.resolve({ rows: [{ bike_id: "BC-01" }] });
      }
      if (isAutoPauseUpdate(sql)) {
        // paused_at IS NULL guard no longer matches -> zero rows the 2nd time.
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await store.persistLockReport(IMEI, lockReportMessage(), AT);

    expect(rideEventsEmitMock).not.toHaveBeenCalled();
  });
});

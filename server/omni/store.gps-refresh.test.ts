// Covers the gps-refresh-registry integration inside persistLockReport's
// "position" case: a valid fix must consume an armed GPS-refresh expectation
// and emit lockGpsEvents.LOCK_GPS_REFRESHED, but ONLY when the UPDATE actually
// landed a row (rowCount > 0) — an out-of-order report rejected by
// NEWEST_REPORT_GUARD must never be forwarded as a "fresh" position.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OmniMessage } from "@shared/omni/protocol";

const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
const consumePendingGpsRefreshMock = vi.hoisted(() => vi.fn());
const lockGpsEventsEmitMock = vi.hoisted(() => vi.fn());

vi.mock("../db/bootstrap", () => ({
  pool: poolMock,
  db: {},
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./pause-registry", () => ({
  consumePendingPause: vi.fn(),
  registerPendingPause: vi.fn(),
  clearPendingPause: vi.fn(),
  hasPendingPause: vi.fn(),
}));
vi.mock("./gps-refresh-registry", () => ({
  consumePendingGpsRefresh: consumePendingGpsRefreshMock,
  registerPendingGpsRefresh: vi.fn(),
  clearPendingGpsRefresh: vi.fn(),
  hasPendingGpsRefresh: vi.fn(),
}));
vi.mock("../storage/events", () => ({
  rideEvents: { emit: vi.fn() },
  lockGpsEvents: { emit: lockGpsEventsEmitMock },
  LOCK_GPS_REFRESHED: "refreshed",
}));

import { PgOmniStore } from "./store";

const IMEI = "861234567890123";
const AT = 1_755_000_000_000;
const store = new PgOmniStore();

function positionMessage(valid: boolean): OmniMessage {
  return {
    type: "position",
    at: AT,
    valid,
    fix: valid ? { lat: 54.71, lng: 20.51 } : undefined,
  } as unknown as OmniMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("persistLockReport position case — gps-refresh-registry integration", () => {
  it("consumes an armed refresh and emits LOCK_GPS_REFRESHED when the fix lands", async () => {
    poolMock.query.mockResolvedValue({ rows: [], rowCount: 1 });
    consumePendingGpsRefreshMock.mockReturnValue({ bikeId: "BC-01", imei: IMEI, expiresAt: AT + 1000 });

    await store.persistLockReport(IMEI, positionMessage(true), AT);

    expect(consumePendingGpsRefreshMock).toHaveBeenCalledWith(IMEI);
    expect(lockGpsEventsEmitMock).toHaveBeenCalledWith("refreshed", {
      imei: IMEI, bikeId: "BC-01", lat: 54.71, lng: 20.51,
    });
  });

  it("does not consume or emit when no refresh is armed for this lock", async () => {
    poolMock.query.mockResolvedValue({ rows: [], rowCount: 1 });
    consumePendingGpsRefreshMock.mockReturnValue(null);

    await store.persistLockReport(IMEI, positionMessage(true), AT);

    expect(consumePendingGpsRefreshMock).toHaveBeenCalledWith(IMEI);
    expect(lockGpsEventsEmitMock).not.toHaveBeenCalled();
  });

  it("does NOT consume the registry when the UPDATE is rejected as out-of-order (rowCount 0)", async () => {
    poolMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
    consumePendingGpsRefreshMock.mockReturnValue({ bikeId: "BC-01", imei: IMEI, expiresAt: AT + 1000 });

    await store.persistLockReport(IMEI, positionMessage(true), AT);

    expect(consumePendingGpsRefreshMock).not.toHaveBeenCalled();
    expect(lockGpsEventsEmitMock).not.toHaveBeenCalled();
  });

  it("does not touch the registry at all for an invalid (no-fix) position report", async () => {
    poolMock.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await store.persistLockReport(IMEI, positionMessage(false), AT);

    expect(consumePendingGpsRefreshMock).not.toHaveBeenCalled();
    expect(lockGpsEventsEmitMock).not.toHaveBeenCalled();
  });
});

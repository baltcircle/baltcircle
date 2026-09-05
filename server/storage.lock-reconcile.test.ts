// Audit: lock-open-while-available (2026-09 production incident, BC-001).
// reconcileUnattendedOpenLock is the other half of the fix that does NOT go
// through startRide/endRide at all: it fires when a genuinely late/
// unsolicited positive unlock echo arrives well after the original caller
// already gave up (server/omni/server.ts's onUnsolicitedUnlockEcho ->
// server/index.ts's wiring), on whatever bike currently holds that IMEI —
// regardless of ride state, since by then there may be no ride object left
// to hang the fix off of at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

const poolMock = vi.hoisted(() => ({ query: vi.fn() }));
const dbMock = vi.hoisted(() => ({}));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));

import { storage } from "./storage";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileUnattendedOpenLock (audit: lock-open-while-available, 2026-09)", () => {
  it("moves the matching available bike to maintenance, invalidates the cache, and fires the critical alert", async () => {
    poolMock.query.mockResolvedValue({ rows: [{ id: "BC-01" }] });
    const cacheSpy = vi.spyOn(storage, "invalidateBikesCache").mockImplementation(() => {});
    const alertSpy = vi.spyOn(storage, "createLockOpenUnattendedAlert").mockResolvedValue(null);

    await storage.reconcileUnattendedOpenLock("861234567890123", 1000);

    expect(poolMock.query).toHaveBeenCalledTimes(1);
    const [sqlText, params] = poolMock.query.mock.calls[0] as [string, unknown[]];
    expect(sqlText).toContain("SET status = 'maintenance'");
    expect(sqlText).toContain("maintenance_reason = 'auto:lock_open_unattended'");
    expect(sqlText).toContain("WHERE lock_imei = $1 AND status = 'available'");
    expect(params).toEqual(["861234567890123", 1000]);
    expect(cacheSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith("BC-01", 1000);
  });

  it("is a no-op — no cache invalidation, no alert — when no bike is currently available under that IMEI", async () => {
    // Covers: unbound IMEI, or the bike already left "available" for any
    // other reason (rented/maintenance/lost/etc.) by the time the late echo
    // lands — this must never clobber a status some other flow already set.
    poolMock.query.mockResolvedValue({ rows: [] });
    const cacheSpy = vi.spyOn(storage, "invalidateBikesCache").mockImplementation(() => {});
    const alertSpy = vi.spyOn(storage, "createLockOpenUnattendedAlert").mockResolvedValue(null);

    await storage.reconcileUnattendedOpenLock("861234567890123", 1000);

    expect(cacheSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

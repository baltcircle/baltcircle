import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { adminCreateLockSchema, adminUpdateLockSchema, locks } from "./schema";

const GATEWAY_TELEMETRY_COLUMNS = [
  "lastLockState",
  "lastLatitude",
  "lastLongitude",
  "lastLocationAt",
  "bleKey",
  "deviceTypeCode",
  "lastAlarmType",
  "lastAlarmAt",
] as const;

describe("locks protocol telemetry schema", () => {
  it("declares each gateway telemetry field as nullable with no creation default", () => {
    const columns = getTableColumns(locks);

    for (const name of GATEWAY_TELEMETRY_COLUMNS) {
      expect(columns[name]).toBeDefined();
      expect(columns[name].notNull).toBe(false);
      expect(columns[name].hasDefault).toBe(false);
    }
  });

  it("keeps gateway telemetry out of manual lock creation and updates", () => {
    const telemetry = {
      lastSeenAt: 1_700_000_000_000,
      lastBatteryVoltage: 4.2,
      lastSignalStrength: 4,
      lastLockState: "locked",
      lastLatitude: 54.7104,
      lastLongitude: 20.4522,
      lastLocationAt: 1_700_000_000_000,
      bleKey: "12345678",
      deviceTypeCode: "C4",
      lastAlarmType: "fall",
      lastAlarmAt: 1_700_000_000_000,
    };

    expect(adminCreateLockSchema.parse({ imei: "861234567890123", ...telemetry })).toEqual({
      imei: "861234567890123",
    });
    expect(adminUpdateLockSchema.parse({ notes: "Registry note", ...telemetry })).toEqual({
      notes: "Registry note",
    });
  });
});

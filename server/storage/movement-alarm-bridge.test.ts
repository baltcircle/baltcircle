import { describe, expect, it, vi } from "vitest";
import { handleMovementAlarm, movementAlarmRaisesFall, type MovementAlarmAlertSink } from "./movement-alarm-bridge";

const payload = { imei: "000000000000000", bikeId: "BC-002", at: 1_700_000_000_000 };

function sink(overrides: Partial<Record<keyof MovementAlarmAlertSink, ReturnType<typeof vi.fn>>> = {}) {
  return {
    createMovementAlert: overrides.createMovementAlert ?? vi.fn().mockResolvedValue(null),
    createFallAlert: overrides.createFallAlert ?? vi.fn().mockResolvedValue(null),
  };
}

describe("movementAlarmRaisesFall", () => {
  it("is on by default", () => {
    expect(movementAlarmRaisesFall({})).toBe(true);
    expect(movementAlarmRaisesFall({ MOVEMENT_ALARM_AS_FALL: "  " })).toBe(true);
    expect(movementAlarmRaisesFall({ MOVEMENT_ALARM_AS_FALL: "1" })).toBe(true);
  });
  it.each(["0", "false", "OFF", " no "])("is disabled by %j", (v) => {
    expect(movementAlarmRaisesFall({ MOVEMENT_ALARM_AS_FALL: v })).toBe(false);
  });
});

describe("handleMovementAlarm", () => {
  it("raises both movement and fall alerts on the first signal", async () => {
    const s = sink();
    await handleMovementAlarm(s, payload, vi.fn(), {});
    expect(s.createMovementAlert).toHaveBeenCalledWith("BC-002", payload.at);
    expect(s.createFallAlert).toHaveBeenCalledWith("BC-002", payload.at);
  });

  it("keeps the old behaviour when disabled", async () => {
    const s = sink();
    await handleMovementAlarm(s, payload, vi.fn(), { MOVEMENT_ALARM_AS_FALL: "0" });
    expect(s.createMovementAlert).toHaveBeenCalledTimes(1);
    expect(s.createFallAlert).not.toHaveBeenCalled();
  });

  it("one failing alert does not block the other and never throws", async () => {
    const log = vi.fn();
    const s = sink({ createMovementAlert: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(handleMovementAlarm(s, payload, log, {})).resolves.toBeUndefined();
    expect(s.createFallAlert).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("movement-alert create failed"));

    const log2 = vi.fn();
    const s2 = sink({ createFallAlert: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(handleMovementAlarm(s2, payload, log2, {})).resolves.toBeUndefined();
    expect(s2.createMovementAlert).toHaveBeenCalledTimes(1);
    expect(log2).toHaveBeenCalledWith(expect.stringContaining("movement-as-fall alert create failed"));
  });
});

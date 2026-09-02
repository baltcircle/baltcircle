import { describe, expect, it, beforeEach } from "vitest";
import {
  recordMovementAlarm,
  resetMovementAlarmStreak,
  MOVEMENT_ALARM_THEFT_THRESHOLD,
} from "./theft-registry";

describe("theft-registry", () => {
  const imei = "861234567890123";
  const other = "861234567890999";

  beforeEach(() => {
    resetMovementAlarmStreak(imei);
    resetMovementAlarmStreak(other);
  });

  it("increments a per-imei streak on each call, starting at 1", () => {
    expect(recordMovementAlarm(imei)).toBe(1);
    expect(recordMovementAlarm(imei)).toBe(2);
    expect(recordMovementAlarm(imei)).toBe(3);
  });

  it("tracks streaks independently per imei", () => {
    recordMovementAlarm(imei);
    recordMovementAlarm(imei);
    expect(recordMovementAlarm(other)).toBe(1);
    expect(recordMovementAlarm(imei)).toBe(3);
  });

  it("reaches the theft threshold after 6 consecutive calls with no reset", () => {
    let streak = 0;
    for (let i = 0; i < MOVEMENT_ALARM_THEFT_THRESHOLD; i++) streak = recordMovementAlarm(imei);
    expect(streak).toBe(MOVEMENT_ALARM_THEFT_THRESHOLD);
  });

  it("resets the streak back to zero", () => {
    recordMovementAlarm(imei);
    recordMovementAlarm(imei);
    resetMovementAlarmStreak(imei);
    expect(recordMovementAlarm(imei)).toBe(1);
  });

  it("resetting an imei with no recorded streak is a harmless no-op", () => {
    expect(() => resetMovementAlarmStreak("never-seen-imei")).not.toThrow();
  });
});

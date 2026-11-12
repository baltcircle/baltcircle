import type { Alert } from "@shared/schema";
import type { LockMovementAlarmPayload } from "./events";

/**
 * TEMPORARY (presentation for the municipal administration, 2026-11):
 * every OMNI "illegal movement" alarm (code 1) additionally raises the
 * dashboard "fall" alarm from the very first signal. The movement_alarm row
 * and the 6-alarm theft streak (server/omni/theft-registry.ts) are untouched.
 *
 * On by default; set MOVEMENT_ALARM_AS_FALL=0|false|off|no to disable
 * without a code change. Remove this module once the presentation is over.
 */
export function movementAlarmRaisesFall(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MOVEMENT_ALARM_AS_FALL;
  if (raw == null || raw.trim() === "") return true;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

export interface MovementAlarmAlertSink {
  createMovementAlert(bikeId: string, at: number): Promise<Alert | null>;
  createFallAlert(bikeId: string, at: number): Promise<Alert | null>;
}

/**
 * Best-effort: each alert is created independently so a failure of one never
 * suppresses the other, and nothing here may throw into the OMNI TCP process.
 */
export async function handleMovementAlarm(
  sink: MovementAlarmAlertSink,
  payload: LockMovementAlarmPayload,
  log: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const tasks: Promise<unknown>[] = [
    sink.createMovementAlert(payload.bikeId, payload.at)
      .catch((err) => log(`movement-alert create failed: bike=${payload.bikeId} ${(err as Error).message}`)),
  ];
  if (movementAlarmRaisesFall(env)) {
    tasks.push(
      sink.createFallAlert(payload.bikeId, payload.at)
        .catch((err) => log(`movement-as-fall alert create failed: bike=${payload.bikeId} ${(err as Error).message}`)),
    );
  }
  await Promise.all(tasks);
}

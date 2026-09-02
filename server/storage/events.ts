// Live event buses used across storage domains (Bike/Lock/Ride) plus the SSE
// HTTP routes that subscribe to them. Pulled out of storage.ts so BaseStorage
// (which emits on bikeEvents from invalidateBikesCache) and the domain mixin
// files can both import them without storage.ts <-> base.ts import cycles.
import { EventEmitter } from "node:events";

// ---------- Live active-ride events (SSE fan-out) ----------
// Single Node process → an in-process emitter is a valid pub/sub bus. The SSE
// endpoint subscribes per userId; ride mutations emit that user's id so only
// the owning rider's stream is pushed a fresh active-ride snapshot. Bumped
// max listeners so many concurrent riders don't trip the leak warning.
export const rideEvents = new EventEmitter();
rideEvents.setMaxListeners(0);
// Event name is the userId; payload is the reason so the handler can decide
// whether to re-read ("start"/"point") or push a terminal null ("end").
export type RideEventReason = "start" | "point" | "end";

// Флот-шина: единый broadcast-канал "fleet". Эмитится при ЛЮБОМ изменении
// набора/статуса велосипедов (старт/конец аренды, бронь, освобождение брони,
// правки из админки). Открытые админ-страницы и карта подписываются на SSE и
// перезапрашивают список сразу, а не по таймеру.
export const bikeEvents = new EventEmitter();
bikeEvents.setMaxListeners(0);
export const BIKE_EVENT_CHANNEL = "fleet";

// Pending-end bridge: a rider's
// "завершить" request arms a short expectation (server/omni/pending-end-registry.ts)
// instead of settling immediately, because ending must wait for the OMNI
// lock's own physical-closure report. Once that report lands,
// persistLockReport's "lockReport" case consumes the armed expectation and
// emits this so the full transactional settlement (storage.endRide, which
// this Drizzle-free module intentionally cannot call directly — see
// server/omni/store.ts's file header) runs on the storage layer. Wired in
// server/storage.ts.
export const pendingEndEvents = new EventEmitter();
pendingEndEvents.setMaxListeners(0);
export const LOCK_CLOSED_FOR_END = "closed-for-end";
export interface LockClosedForEndPayload {
  rideId: number;
  userId: string;
  imei: string;
}

// Fall-alarm bridge: mirrors the GPS-refresh/pending-end bridges above.
// server/omni/store.ts (Drizzle-free, see its file header) detects OMNI
// alarm code 2 ("fall") and emits here; only this storage layer can turn it
// into a persisted `alerts` row (Drizzle) with fleet-dashboard dedup and the
// ack workflow. Wired in server/storage.ts alongside the other two bridges.
export const lockAlarmEvents = new EventEmitter();
lockAlarmEvents.setMaxListeners(0);
export const LOCK_FALL_ALARM = "fall-alarm";
export interface LockFallAlarmPayload {
  imei: string;
  bikeId: string;
  at: number;
}

// Movement-alarm bridge: same shape as the fall bridge above, for OMNI alarm
// code 1 ("illegal movement" — unauthorized movement of a reserved/available
// bike). Shares the lockAlarmEvents bus since both are "OMNI lock alarm →
// fleet-dashboard alert" bridges; kept as a distinct event name (not folded
// into LOCK_FALL_ALARM) because the two map to different `alerts.kind`
// values and different dashboard cards.
export const LOCK_MOVEMENT_ALARM = "movement-alarm";
export interface LockMovementAlarmPayload {
  imei: string;
  bikeId: string;
  at: number;
}

// Auto-offline bridge: mirrors the fall/movement alarm bridges above.
// server/omni/store.ts (Drizzle-free, see its file header) detects a bike
// idling in "available" whose battery telemetry just crossed the
// LOW_BATTERY_AUTO_OFFLINE_THRESHOLD and flips bikes.status to "offline"
// itself (plain SQL, no Drizzle needed for that write) — but only this
// storage layer can turn it into a persisted `alerts` row (Drizzle) with
// fleet-dashboard dedup and the ack workflow. Wired in server/storage.ts.
export const bikeAutoOfflineEvents = new EventEmitter();
bikeAutoOfflineEvents.setMaxListeners(0);
export const BIKE_AUTO_OFFLINE = "auto-offline";
export interface BikeAutoOfflinePayload {
  bikeId: string;
  battery: number;
  /** For the GPS-interval sync (bike-status lifecycle spec, 2026-09) — null if the bike has no lock bound. */
  imei: string | null;
  at: number;
}

// Auto-"lost" (theft) bridge: mirrors the auto-offline bridge above.
// server/omni/store.ts (Drizzle-free, see its file header) counts consecutive
// OMNI alarm code=1 ("illegal movement") reports per lock via
// server/omni/theft-registry.ts; once the streak reaches
// MOVEMENT_ALARM_THEFT_THRESHOLD it flips bikes.status to "lost" itself
// (plain SQL) — but only this storage layer can turn it into a persisted
// `alerts` row (Drizzle) for the dashboard's "Кража велосипеда" card. Wired
// in server/storage.ts, alongside the other bridges.
export const bikeTheftEvents = new EventEmitter();
bikeTheftEvents.setMaxListeners(0);
export const BIKE_AUTO_LOST = "auto-lost";
export interface BikeAutoLostPayload {
  bikeId: string;
  /** For the GPS-interval sync (bike-status lifecycle spec, 2026-09). */
  imei: string;
  at: number;
}

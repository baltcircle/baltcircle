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

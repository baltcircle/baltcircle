// db client + schema bootstrap + migrations + demo seed run on import of this module.
// bootstrapReady MUST be awaited before serving requests (server entrypoint does this).
import { db, pool, bootstrapReady } from "./db/bootstrap";
export { db, pool, bootstrapReady };

// Re-exported for external callers (SSE fan-out, admin bike-list broadcast).
export { bikeEvents, BIKE_EVENT_CHANNEL } from "./storage/events";
import { rideEvents, lockGpsEvents, LOCK_GPS_REFRESHED, pendingEndEvents, LOCK_CLOSED_FOR_END } from "./storage/events";
import type { LockGpsRefreshedPayload, LockClosedForEndPayload } from "./storage/events";
import { log } from "./logger";
import { END_SETTLE_RETRY_INTERVAL_MS, END_SETTLE_RETRY_WINDOW_MS, RIDE_END_AWAITING_LOCK_GPS_ERROR } from "@shared/geo";
export { rideEvents };
import type { RideEventReason } from "./storage/events";
export type { RideEventReason };

// Re-exported: phone normalization / admin-role resolution used outside storage.ts.
export { normalizePhone, isAdminPhone, resolveRole } from "./storage/base";

import { compose } from "./storage/mixin";
import { BaseStorage } from "./storage/base";
import { UserMixin } from "./storage/user";
import { OtpMixin } from "./storage/otp";
import { PaymentMethodMixin } from "./storage/payment-method";
import { SupportMixin } from "./storage/support";
import { WalletMixin } from "./storage/wallet";
import { TicketMixin } from "./storage/ticket";
import { MapObjectMixin } from "./storage/map-object";
import { AnalyticsMixin } from "./storage/analytics";
import { BikeMixin } from "./storage/bike";
import { LockMixin } from "./storage/lock";
import { ParkingMixin } from "./storage/parking";
import { RideMixin } from "./storage/ride";
import { ReservationMixin } from "./storage/reservation";
import { FeedbackMixin } from "./storage/feedback";

// IStorage is split into domain-segmented sub-interfaces; re-exported for callers.
import type { IStorage } from "./storage/interfaces";
export type { IStorage };

// Composition root: DatabaseStorage assembles every domain mixin extracted
// from the original god-class (Stages 1–3 of the refactor) on top of
// BaseStorage's shared cache/helpers. The class body itself is now empty —
// every method lives in its own storage/<domain>.ts mixin file. The class
// must remain zero-arg-constructible: server/storage.account-delete.test.ts
// does `new DatabaseStorage().deleteAccount(...)` directly.
export class DatabaseStorage
  extends compose(BaseStorage)
    .with(UserMixin)
    .with(OtpMixin)
    .with(PaymentMethodMixin)
    .with(SupportMixin)
    .with(WalletMixin)
    .with(TicketMixin)
    .with(MapObjectMixin)
    .with(AnalyticsMixin)
    .with(BikeMixin)
    .with(LockMixin)
    .with(ParkingMixin)
    .with(RideMixin)
    .with(ReservationMixin)
    .with(FeedbackMixin)
    .build()
  implements IStorage
{

}

export const storage = new DatabaseStorage();

// Bridge: server/omni/store.ts (kept dependency-free of Drizzle/storage, see
// its file header) emits here once an opportunistic GPS-refresh burst
// (server/omni/server.ts's requestGpsRefresh) catches a fix; only this
// storage layer can turn that into a bikes.lat/lng update + parking
// recalculation. Best-effort: a failure here must not crash the OMNI TCP
// process or the admin request that originally armed the burst.
lockGpsEvents.on(LOCK_GPS_REFRESHED, (payload: LockGpsRefreshedPayload) => {
  storage.applyGpsRefresh(payload).catch((err) => log(`gps-refresh apply failed: ${(err as Error).message}`));
});

// Bridge: server/omni/store.ts consumes a rider's armed "завершить" request
// once the OMNI lock reports a physical closure and emits here — only this
// storage layer can run the full transactional settlement (billing, bike
// release, geofence check).
//
// Production incident, 2026-08-27: the lock only reports closure ONCE, so a
// single failed attempt here used to be a dead end — endRide's stale-GPS gate
// (RIDE_END_AWAITING_LOCK_GPS_ERROR) can trip on a momentary bad-signal spot
// even though D1 tracking is live and a fresh fix is normally seconds away.
// The rider's own retry taps hit the SAME fast path (requestEndRide's
// physically_locked_at check) and got the SAME error every time, with no way
// to self-resolve short of the lock's GPS happening to be fresh at the exact
// moment of a manual tap. `settleEndWithRetry` below keeps trying on a bounded
// schedule instead of giving up after one shot, so the ride settles on its own
// as soon as a fresh fix lands — the rider's manual retry remains available as
// a fallback, unchanged, if the auto-retry window (END_SETTLE_RETRY_WINDOW_MS)
// runs out first (dead GPS antenna, lock genuinely stuck out of any parking
// zone, etc.).
pendingEndEvents.on(LOCK_CLOSED_FOR_END, (payload: LockClosedForEndPayload) => {
  settleEndWithRetry(payload.rideId, Date.now());
});

/**
 * Retry storage.endRide(rideId) every END_SETTLE_RETRY_INTERVAL_MS until it
 * either settles, fails for a non-transient reason, or END_SETTLE_RETRY_WINDOW_MS
 * since the physical closure elapses. Only the exact stale-lock-GPS error is
 * treated as transient/worth retrying — any other error (e.g. "not inside a
 * parking zone") needs the rider to act (move the bike) and retrying it on a
 * timer would just be noise. Best-effort throughout: a failure/timeout here
 * must never crash the OMNI TCP process — the rider's manual "Завершить" tap
 * (requestEndRide's physically_locked_at fast path) is always available as a
 * fallback, since the ride stays "active" the whole time this is retrying.
 */
function settleEndWithRetry(rideId: number, firstAttemptAt: number): void {
  storage.endRide(rideId).then((result) => {
    if (!result) return; // ride no longer active (already settled/cancelled elsewhere) — nothing to do
    if (!("error" in result)) return; // settled successfully — endRide's own side effects already fired
    if (result.error !== RIDE_END_AWAITING_LOCK_GPS_ERROR) {
      log(`pending-end settle failed (non-retryable): ride=${rideId} ${result.error}`);
      return;
    }
    if (Date.now() - firstAttemptAt >= END_SETTLE_RETRY_WINDOW_MS) {
      log(`pending-end settle: gave up after retry window, ride=${rideId} still awaiting fresh lock GPS`);
      return;
    }
    const timer = setTimeout(() => settleEndWithRetry(rideId, firstAttemptAt), END_SETTLE_RETRY_INTERVAL_MS);
    timer.unref?.();
  }).catch((err) => log(`pending-end settle failed: ride=${rideId} ${(err as Error).message}`));
}

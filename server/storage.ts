// db client + schema bootstrap + migrations + demo seed run on import of this module.
// bootstrapReady MUST be awaited before serving requests (server entrypoint does this).
import { db, pool, bootstrapReady } from "./db/bootstrap";
export { db, pool, bootstrapReady };

// Re-exported for external callers (SSE fan-out, admin bike-list broadcast).
export { bikeEvents, BIKE_EVENT_CHANNEL } from "./storage/events";
import { rideEvents } from "./storage/events";
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
    .build()
  implements IStorage
{

}

export const storage = new DatabaseStorage();

// Key under which a QR-scanned bike code is stashed when the app is cold-opened
// via a "/#/bike/<CODE>" deep link. The map reads and clears it once bikes have
// loaded, then auto-opens the rental flow for that bike.
export const PENDING_BIKE_KEY = "bc.pending.bike";

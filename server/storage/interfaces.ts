// Domain-segmented storage interfaces.
//
// IStorage was a single God-object interface listing every persistence method in
// the app. It is split here into cohesive per-domain interfaces which IStorage
// composes via `extends`. This is a pure type-level refactor: the runtime
// DatabaseStorage class is unchanged and still implements the composed IStorage,
// so `tsc` verifies every method is still present with its exact signature.

import type {
  Bike, Parking, ZoneRow, Ride, AdminRide, RideWithFeedback, Ticket, TicketWithComments,
  Payment, Wallet, MapObject, InsertMapObject, User, AdminUser, OtpRequest, UserRole,
  UpdateProfileInput, PaymentMethod, SupportTicket, SupportTicketWithUser,
  SupportTicketStatus, PaymentOrder, AdminCreateBikeInput, AdminUpdateBikeInput,
  CreateTicketInput, UpdateTicketInput, AdminCreateParkingInput, AdminUpdateParkingInput,
  SupportConversation, SupportMessage, SupportMessageRole, AdminSupportConversationRow,
  Lock, AdminCreateLockInput, AdminUpdateLockInput, WalletTopupOrder,
  OauthIdentity, OauthProvider, Reservation,
  RideFeedback, CreateRideFeedbackInput, AdminRideFeedback, Alert,
} from "@shared/schema";

export interface IUserStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByPhone(phone: string): Promise<User | undefined>;
  updateProfile(id: string, patch: UpdateProfileInput): Promise<{ user: User } | { error: string }>;
  /**
   * Removes direct account data while retaining immutable ride/payment ledger
   * records under the opaque user id. The second active-ride check happens
   * inside the write transaction to close the check/finalize race.
   */
  deleteAccount(userId: string): Promise<{ ok: true } | { error: "active_ride" | "not_found" }>;
  // admin user management
  listUsers(opts?: { limit?: number; offset?: number }): Promise<AdminUser[]>;
  countUsers(): Promise<number>;
  setUserRole(id: string, role: UserRole): Promise<{ user: User } | { error: string }>;
  setUserBlocked(id: string, blocked: boolean, reason?: string): Promise<{ user: User } | { error: string }>;
}

export interface IOtpStorage {
  startOtp(input: { phone: string }): Promise<
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number }
  >;
  // Existing phone: logs the rider in. New phone: does NOT create an account
  // yet (no name/email/consent collected) — returns the normalized phone so
  // the caller can bind it to the session pending registration completion.
  verifyOtp(input: { phone: string; code: string }): Promise<
    | { status: "login"; user: User }
    | { status: "register"; phone: string }
    | { error: string }
  >;
  completeRegistration(input: { phone: string; name: string; email: string; consentIp?: string }): Promise<
    { user: User } | { error: string }
  >;
  // OTP delivery diagnostics (provider id/status persisted per phone)
  recordOtpSend(input: {
    phone: string;
    provider?: string;
    providerMessageId?: string;
    providerStatus?: string;
    providerError?: string;
  }): Promise<void>;
  getLastOtpSend(phone: string): Promise<OtpRequest | undefined>;
  updateOtpProviderStatus(input: {
    phone: string;
    providerStatus?: string;
    providerError?: string;
  }): Promise<void>;
  // Periodic TTL cleanup for otp_requests/phone_change_requests/
  // email_change_requests (audit MEDIUM, Платежи track). See implementation
  // in storage.ts for the retention rationale.
  purgeExpiredContactRequests(): Promise<{ otp: number; phoneChange: number; emailChange: number }>;
  // phone change (SMS OTP for an existing account)
  startPhoneChange(input: { userId: string; phone: string }): Promise<
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number }
  >;
  verifyPhoneChange(input: { userId: string; code: string }): Promise<{ user: User } | { error: string }>;
  // email change (RuSender OTP, mirrors phone change)
  startEmailChange(input: { userId: string; email: string }): Promise<
    | { ok: true; email: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number }
  >;
  verifyEmailChange(input: { userId: string; code: string }): Promise<{ user: User } | { error: string }>;
  unlinkEmail(userId: string): Promise<{ user: User } | { error: string }>;
  // OAuth identities (Yandex ID / VK ID)
  listOauthIdentities(userId: string): Promise<OauthIdentity[]>;
  linkOauthIdentity(params: {
    userId: string; provider: OauthProvider; subject: string;
    email?: string | null; displayName?: string | null;
  }): Promise<{ error: string } | { ok: true; identity: OauthIdentity }>;
  unlinkOauthIdentity(userId: string, provider: OauthProvider): Promise<{ ok: true }>;
  findUserByOauth(provider: OauthProvider, subject: string, email?: string | null): Promise<User | null>;
}

export interface IPaymentMethodStorage {
  // payment methods (metadata only — no card data)
  listPaymentMethods(userId: string): Promise<PaymentMethod[]>;
  linkPaymentMethod(userId: string, type: "card" | "sbp"): Promise<PaymentMethod>;
  unlinkPaymentMethod(userId: string, id: number): Promise<boolean>;
  // T-Bank card binding (real acquiring metadata)
  createPendingCardMethod(input: { userId: string; customerKey: string; requestKey?: string }): Promise<PaymentMethod>;
  createPendingBindPayment(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    amountKopecks: number;
  }): Promise<PaymentMethod>;
  // SBP account binding (AddAccountQr): a pending sbp-type method keyed by the
  // RequestKey so the notification/state poll can attach the AccountToken.
  createPendingSbpBinding(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    requestKey?: string;
  }): Promise<PaymentMethod>;
  getPaymentMethod(id: number): Promise<PaymentMethod | undefined>;
  // Atomic compare-and-swap guard against concurrent double-refund: only the
  // caller whose claim actually flips refundStatus wins the right to call
  // T-Bank's /Cancel for this method. See implementation for why this exists
  // (the notification webhook and the client's refresh-bind polling can both
  // observe the same method going "active" concurrently).
  claimRefund(methodId: number): Promise<boolean>;
  findPendingCardMethod(userId: string): Promise<PaymentMethod | undefined>;
  findCardMethodByOrderId(orderId: string): Promise<PaymentMethod | undefined>;
  findCardMethodByRequestKey(userId: string, requestKey: string): Promise<PaymentMethod | undefined>;
  // Locate any T-Bank method (card or sbp) by RequestKey alone — used by the SBP
  // binding notification, which carries a RequestKey but no user id.
  findMethodByRequestKey(requestKey: string): Promise<PaymentMethod | undefined>;
  // The rider's saved SBP account usable for a recurring charge (active + token).
  getActiveSavedSbp(userId: string, paymentMethodId?: number): Promise<PaymentMethod | undefined>;
  updatePaymentMethod(id: number, patch: Partial<PaymentMethod>): Promise<PaymentMethod | undefined>;
  // The rider's saved T-Bank card usable for a recurring charge (active + RebillId)
  getActiveSavedCard(userId: string, paymentMethodId?: number): Promise<PaymentMethod | undefined>;
  // Active-карта с тем же last4 (+ брендом, когда он известен), исключая
  // активируемую pending-запись. Нужна, чтобы не сохранить одну физическую
  // карту несколько раз при том, что разных карт у райдера может быть несколько.
  findActiveCardDuplicate(
    userId: string,
    last4: string,
    brand: string | null,
    excludeMethodId?: number,
  ): Promise<PaymentMethod | undefined>;
  // T-Bank ride payment orders (hosted pay-then-start AND saved-card charge)
  createRidePaymentOrder(input: {
    orderId: string;
    userId: string;
    bikeId: string;
    tariffId: string;
    amountKopecks: number;
    source?: "hosted" | "saved_card";
    paymentMethodId?: number;
    rebillId?: string;
  }): Promise<PaymentOrder>;
  getRidePaymentOrder(orderId: string): Promise<PaymentOrder | undefined>;
  updateRidePaymentOrder(id: number, patch: Partial<PaymentOrder>): Promise<PaymentOrder | undefined>;
  claimRidePaymentOrderForProcessing(id: number): Promise<PaymentOrder | undefined>;
  // Idempotency-guarded reservation (audit HIGH #2) — see implementation for
  // the reserve-before-charge rationale.
  reserveRidePaymentOrder(input: {
    orderId: string;
    userId: string;
    bikeId: string;
    tariffId: string;
    amountKopecks: number;
    source?: "hosted" | "saved_card" | "saved_sbp";
    paymentMethodId?: number;
    rebillId?: string;
    idempotencyKey: string;
    rideId?: number;
    purpose?: "ride_overage";
  }): Promise<{ order: PaymentOrder; created: boolean }>;
  getRidePaymentOrderByIdempotencyKey(userId: string, idempotencyKey: string): Promise<PaymentOrder | undefined>;
  // Most recent successfully-PAID saved-card/SBP order for a ride (start OR
  // extend) — tells the caller which payment method actually funded this
  // ride's tariff, so overage at settlement can be charged the same way.
  // undefined means the ride was funded from the internal wallet only.
  getLatestPaidRidePaymentOrder(rideId: number): Promise<PaymentOrder | undefined>;
}

export interface ISupportStorage {
  // support tickets (rider help requests)
  listSupportTickets(userId: string): Promise<SupportTicket[]>;
  createSupportTicket(input: { userId: string; subject: string; message: string }): Promise<SupportTicket>;
  // support tickets (staff/operator inbox — all riders)
  listAllSupportTickets(): Promise<SupportTicketWithUser[]>;
  updateSupportTicket(id: number, patch: { status?: SupportTicketStatus }): Promise<SupportTicket | undefined>;
  // support chat (continuous conversation per rider)
  ensureSupportConversation(userId: string): Promise<SupportConversation>;
  listSupportMessages(conversationId: number, opts?: { afterId?: number; limit?: number }): Promise<SupportMessage[]>;
  appendSupportMessage(input: { conversationId: number; senderRole: SupportMessageRole; senderId: string | null; body: string; attachmentUrl?: string | null; attachmentMime?: string | null }): Promise<SupportMessage>;
  markSupportRead(conversationId: number, reader: "user" | "operator"): Promise<void>;
  setSupportMode(conversationId: number, mode: "bot" | "human"): Promise<void>;
  listAllSupportConversations(): Promise<AdminSupportConversationRow[]>;
  getSupportConversation(id: number): Promise<SupportConversation | undefined>;
}

export interface IBikeStorage {
  listBikes(opts?: { includeArchived?: boolean }): Promise<Bike[]>;
  getBike(id: string): Promise<Bike | undefined>;
  updateBike(id: string, patch: Partial<Bike>): Promise<Bike | undefined>;
  // bikes — admin CRUD (staff only)
  createBike(input: AdminCreateBikeInput): Promise<{ bike: Bike } | { error: string }>;
  adminUpdateBike(id: string, patch: AdminUpdateBikeInput): Promise<{ bike: Bike } | { error: string }>;
  archiveBike(id: string): Promise<{ bike: Bike } | { error: string }>;
  restoreBike(id: string): Promise<{ bike: Bike } | { error: string }>;
  deleteBike(id: string): Promise<{ ok: true } | { error: string; archived?: Bike }>;
  purgeArchivedTestBike(id: string): Promise<
    | { ok: true; deleted: Record<
        "rides" | "tickets" | "paymentOrders" | "reservations" | "alerts" | "ticketComments" | "rideFeedback" | "ridePoints" | "telemetry",
        number
      > }
    | { error: string }
  >;
  // Registry locks that have not yet been fitted to a bike.
  listUnassignedLocks(): Promise<{ imei: string; lastSeen: number | null }[]>;
  // Locks seen dialling into the OMNI gateway but not yet registered at all.
  listDiscoveredLocks(): Promise<{ imei: string; firstSeen: number; lastSeen: number }[]>;
  /**
   * Deletes raw lock heartbeat/telemetry rows older than the retention
   * window. Independent of ride_points (permanent per-ride track history) —
   * bike_telemetry is high-volume check-in noise with no ride linkage.
   * Batched: deletes at most `maxBatches * batchSize` rows per call so a
   * large backlog (e.g. first run after enabling retention) can't hold a
   * single long-running transaction/lock. Returns rows actually deleted.
   */
  purgeOldTelemetry(opts?: { maxBatches?: number; batchSize?: number }): Promise<number>;
}

export interface ILockStorage {
  listLocks(): Promise<Lock[]>;
  createLock(input: AdminCreateLockInput): Promise<{ lock: Lock } | { error: string }>;
  getLock(id: number): Promise<Lock | undefined>;
  updateLock(id: number, patch: AdminUpdateLockInput): Promise<{ lock: Lock } | { error: string }>;
  decommissionLock(id: number): Promise<{ lock: Lock } | { error: string }>;
}

export interface IAlertStorage {
  /** Best-effort, dedup-on-insert. See server/storage/alert.ts for details. */
  createFallAlert(bikeId: string, at: number): Promise<Alert | null>;
  /** Best-effort, dedup-on-insert. See server/storage/alert.ts for details. */
  createMovementAlert(bikeId: string, at: number): Promise<Alert | null>;
  createTheftAlert(bikeId: string, at: number): Promise<Alert | null>;
  /** Best-effort, dedup-on-insert. See server/storage/alert.ts for details. */
  createLowBatteryOfflineAlert(bikeId: string, battery: number, at: number): Promise<Alert | null>;
  /** Best-effort, plain insert (NO dedup) — see server/storage/alert.ts for details. */
  createOverageChargeFailedAlert(bikeId: string, rideId: number, userId: string, amountKopecks: number, reason: string, at: number): Promise<Alert | null>;
  listAlerts(opts?: { includeAcknowledged?: boolean }): Promise<Alert[]>;
  acknowledgeAlert(id: number, by: string): Promise<Alert | undefined>;
}

export interface IParkingStorage {
  listParkings(opts?: { includeInactive?: boolean; includeArchived?: boolean }): Promise<Parking[]>;
  getParking(id: string): Promise<Parking | undefined>;
  createParking(input: AdminCreateParkingInput): Promise<{ parking: Parking } | { error: string }>;
  updateParking(id: string, patch: AdminUpdateParkingInput): Promise<{ parking: Parking } | { error: string }>;
  archiveParking(id: string): Promise<{ parking: Parking } | { error: string }>;
  restoreParking(id: string): Promise<{ parking: Parking } | { error: string }>;
  deleteParking(id: string): Promise<{ ok: true } | { error: string; archived?: Parking }>;
  // zones
  listZones(): Promise<ZoneRow[]>;
}

export interface IRideStorage {
  // Audit F-07: the current active ride on a bike, if any — used by the admin
  // manual-unlock endpoint to avoid opening a bike mid-ride for another rider.
  getActiveRideForBike(bikeId: string): Promise<Ride | undefined>;
  startRide(input: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }): Promise<Ride | { error: string }>;
  appendRidePoint(rideId: number, x: number, y: number): Promise<Ride | undefined>;
  insertBikeTelemetry(bikeId: string, x: number, y: number, t: number): Promise<void>;
  getBikeTelemetry(bikeId: string, fromT: number, toT: number): Promise<[number, number, number][]>;
  endRide(rideId: number, opts?: { skipGeofence?: boolean }): Promise<Ride | { error: string } | undefined>;
  requestPauseRide(rideId: number): Promise<{ status: "awaiting_lock_close"; expiresInMs: number } | { status: "paused"; ride: Ride } | { error: string }>;
  requestEndRide(rideId: number): Promise<{ status: "awaiting_lock_close"; expiresInMs: number } | Ride | { error: string } | undefined>;
  cancelPendingEnd(rideId: number): Promise<{ ok: true } | { error: string }>;
  resumeRide(rideId: number): Promise<Ride | { error: string }>;
  extendRide(rideId: number, tariff: string): Promise<Ride | { error: string }>;
  getRide(rideId: number): Promise<Ride | undefined>;
  getActiveRides(userId: string): Promise<Ride[]>;
  listRides(opts?: { userId?: string; limit?: number }): Promise<RideWithFeedback[]>;
  listAdminRides(opts?: { limit?: number; offset?: number }): Promise<AdminRide[]>;
  countRides(): Promise<number>;
}

export interface IWalletStorage {
  getWallet(userId: string): Promise<Wallet>;
  // Credits the wallet atomically. Callers MUST gate this behind a confirmed
  // real payment (T-Bank webhook, see handleWalletTopupNotification) or an
  // explicit non-production test fixture — never behind a bare client request
  // (audit CRITICAL #1: this used to be reachable directly from HTTP).
  topUp(userId: string, amount: number): Promise<{ wallet: Wallet; payment: Payment }>;
  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number, idempotencyKey?: string): Promise<{ wallet: Wallet; payment: Payment }>;
  listPayments(userId: string): Promise<Payment[]>;
  // T-Bank wallet top-up orders (pay now, credit balance once confirmed)
  createWalletTopupOrder(input: { orderId: string; userId: string; amountKopecks: number }): Promise<WalletTopupOrder>;
  getWalletTopupOrder(orderId: string): Promise<WalletTopupOrder | undefined>;
  updateWalletTopupOrder(id: number, patch: Partial<WalletTopupOrder>): Promise<WalletTopupOrder | undefined>;
  claimWalletTopupOrderForProcessing(id: number): Promise<WalletTopupOrder | undefined>;
}

export interface ITicketStorage {
  // service / maintenance tickets
  listTickets(opts?: { limit?: number; offset?: number }): Promise<Ticket[]>;
  countTickets(): Promise<number>;
  getTicket(id: number): Promise<TicketWithComments | undefined>;
  createTicket(input: CreateTicketInput): Promise<TicketWithComments>;
  updateTicket(id: number, patch: UpdateTicketInput, actor: string): Promise<TicketWithComments | undefined>;
  addTicketComment(id: number, author: string, body: string): Promise<TicketWithComments | undefined>;
}

export interface IMapObjectStorage {
  // map objects (operator-drawn routes/zones)
  listMapObjects(opts?: { activeOnly?: boolean }): Promise<MapObject[]>;
  createMapObject(input: InsertMapObject): Promise<MapObject>;
  setMapObjectActive(id: number, active: boolean): Promise<MapObject | undefined>;
  updateMapObject(id: number, patch: Partial<{
    name: string;
    type: "route" | "operating" | "slow" | "forbidden";
    kind: "route" | "zone";
    color: string;
    points: [number, number][];
    active: boolean;
  }>): Promise<MapObject | undefined>;
  deleteMapObject(id: number): Promise<boolean>;
}

export interface IAnalyticsStorage {
  analytics(): Promise<any>;
  // period-scoped analytics for the admin "Аналитика v1" page
  adminAnalytics(range: { from: number; to: number }): Promise<any>;
}

export interface IFeedbackStorage {
  submitRideFeedback(
    rideId: number,
    userId: string,
    input: CreateRideFeedbackInput,
  ): Promise<RideFeedback | { error: string }>;
  getRideFeedback(rideId: number): Promise<RideFeedback | undefined>;
  // admin Reviews list — every submitted feedback, newest first, enriched
  // with rider identity + bike id (mirrors listAdminRides/countRides).
  listRideFeedback(opts?: { limit?: number; offset?: number }): Promise<AdminRideFeedback[]>;
  countRideFeedback(): Promise<number>;
}

export interface IReservationStorage {
  // Product rule: a rider may hold at most ONE active reservation at a time
  // (across any bike) — see createReservation's implementation for the
  // atomic enforcement. Returns an error string on any precondition failure
  // (bike unavailable, rider already has an active ride/reservation).
  createReservation(input: { bikeId: string; userId: string }): Promise<{ reservation: Reservation } | { error: string }>;
  getActiveReservationForUser(userId: string): Promise<Reservation | undefined>;
  getActiveReservationForBike(bikeId: string): Promise<Reservation | undefined>;
  // Owner-only cancel; returns an error string if the reservation doesn't
  // exist, isn't active, or belongs to a different user.
  cancelReservation(id: number, userId: string): Promise<{ ok: true } | { error: string }>;
  // Sweep entry point (server/index.ts interval) — flips overdue "active"
  // reservations to "expired" and frees the underlying bike back to
  // "available". Returns how many rows were expired (for logging).
  expireOverdueReservations(): Promise<number>;
}

// Facade composing every domain interface. `import { storage }` continues to
// expose all methods through the single DatabaseStorage implementation.
export interface IStorage
  extends IUserStorage,
    IOtpStorage,
    IPaymentMethodStorage,
    ISupportStorage,
    IBikeStorage,
    ILockStorage,
    IAlertStorage,
    IParkingStorage,
    IRideStorage,
    IWalletStorage,
    ITicketStorage,
    IMapObjectStorage,
    IAnalyticsStorage,
    IReservationStorage,
    IFeedbackStorage {}

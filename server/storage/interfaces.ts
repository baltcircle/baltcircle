// Domain-segmented storage interfaces.
//
// IStorage was a single God-object interface listing every persistence method in
// the app. It is split here into cohesive per-domain interfaces which IStorage
// composes via `extends`. This is a pure type-level refactor: the runtime
// DatabaseStorage class is unchanged and still implements the composed IStorage,
// so `tsc` verifies every method is still present with its exact signature.

import type {
  Bike, Parking, ZoneRow, Ride, AdminRide, Ticket, TicketWithComments,
  Payment, Wallet, MapObject, InsertMapObject, User, OtpRequest, UserRole,
  UpdateProfileInput, PaymentMethod, SupportTicket, SupportTicketWithUser,
  SupportTicketStatus, PaymentOrder, AdminCreateBikeInput, AdminUpdateBikeInput,
  CreateTicketInput, UpdateTicketInput, AdminCreateParkingInput, AdminUpdateParkingInput,
  SupportConversation, SupportMessage, SupportMessageRole, AdminSupportConversationRow,
} from "@shared/schema";

export interface IUserStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByPhone(phone: string): Promise<User | undefined>;
  updateProfile(id: string, patch: UpdateProfileInput): Promise<{ user: User } | { error: string }>;
  // admin user management
  listUsers(opts?: { limit?: number; offset?: number }): Promise<User[]>;
  countUsers(): Promise<number>;
  setUserRole(id: string, role: UserRole): Promise<{ user: User } | { error: string }>;
  setUserBlocked(id: string, blocked: boolean, reason?: string): Promise<{ user: User } | { error: string }>;
}

export interface IOtpStorage {
  startOtp(input: { name: string; phone: string }): Promise<
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number }
  >;
  verifyOtp(input: { phone: string; code: string; consentIp?: string }): Promise<{ user: User } | { error: string }>;
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
  // phone change (SMS OTP for an existing account)
  startPhoneChange(input: { userId: string; phone: string }): Promise<
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number }
  >;
  verifyPhoneChange(input: { userId: string; code: string }): Promise<{ user: User } | { error: string }>;
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
  // Уже привязанная или привязываемая сейчас карта пользователя (active или pending).
  // Используется, чтобы не давать привязать вторую карту (одна карта на райдера).
  getBlockingCard(userId: string): Promise<PaymentMethod | undefined>;
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
  deleteBike(id: string): Promise<{ ok: true } | { error: string; archived?: Bike }>;
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
  startRide(input: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }): Promise<Ride | { error: string }>;
  appendRidePoint(rideId: number, x: number, y: number): Promise<Ride | undefined>;
  insertBikeTelemetry(bikeId: string, x: number, y: number, t: number): Promise<void>;
  getBikeTelemetry(bikeId: string, fromT: number, toT: number): Promise<[number, number, number][]>;
  endRide(rideId: number): Promise<Ride | undefined>;
  getRide(rideId: number): Promise<Ride | undefined>;
  getActiveRide(userId: string): Promise<Ride | undefined>;
  listRides(opts?: { userId?: string; limit?: number }): Promise<Ride[]>;
  listAdminRides(opts?: { limit?: number; offset?: number }): Promise<AdminRide[]>;
  countRides(): Promise<number>;
}

export interface IWalletStorage {
  getWallet(userId: string): Promise<Wallet>;
  topUp(userId: string, amount: number): Promise<{ wallet: Wallet; payment: Payment }>;
  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number): Promise<{ wallet: Wallet; payment: Payment }>;
  listPayments(userId: string): Promise<Payment[]>;
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

// Facade composing every domain interface. `import { storage }` continues to
// expose all methods through the single DatabaseStorage implementation.
export interface IStorage
  extends IUserStorage,
    IOtpStorage,
    IPaymentMethodStorage,
    ISupportStorage,
    IBikeStorage,
    IParkingStorage,
    IRideStorage,
    IWalletStorage,
    ITicketStorage,
    IMapObjectStorage,
    IAnalyticsStorage {}

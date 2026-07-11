import {
  bikes, parkings, zones, rides, tickets, ticketComments, payments, wallet, mapObjects, users,
  otpRequests, phoneChangeRequests, paymentMethods, supportTickets, paymentOrders,
  supportConversations, supportMessages,
  TICKET_CLOSED_STATUSES,
} from "@shared/schema";
import type {
  Bike, Parking, ZoneRow, Ride, AdminRide, Ticket, TicketComment, TicketWithComments, Payment, Wallet,
  MapObject, InsertMapObject, User, OtpRequest, UserRole, UpdateProfileInput,
  PhoneChangeRequest, PaymentMethod, SupportTicket, SupportTicketWithUser, SupportTicketStatus, PaymentOrder,
  AdminCreateBikeInput, AdminUpdateBikeInput, CreateTicketInput, UpdateTicketInput,
  AdminCreateParkingInput, AdminUpdateParkingInput,
  SupportConversation, SupportMessage, SupportMessageRole, AdminSupportConversationRow,
} from "@shared/schema";
import { CONSENT_VERSION } from "@shared/schema";
import { randomUUID, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  PARKINGS, OPERATING_ZONE, SLOW_ZONES, FORBIDDEN_ZONES, MAP_W, MAP_H,
  TARIFFS, tariffPriceKopecks,
} from "@shared/geo";
import { computeOverage, finalRideCost } from "@shared/billing";
import { eq, desc, sql, gt, and, asc } from "drizzle-orm";
import { EventEmitter } from "node:events";
// db client + schema bootstrap + migrations + demo seed run on import of this module.
// bootstrapReady MUST be awaited before serving requests (server entrypoint does this).
import { db, pool, bootstrapReady } from "./db/bootstrap";
export { db, pool, bootstrapReady };

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


// ---------- Storage interface ----------

// Normalize a user-entered phone to a storable canonical form: keep digits and
// a single optional leading "+". A Russian "8XXXXXXXXXX" national number is
// converted to "+7XXXXXXXXXX" so duplicates and display stay consistent.
// ---------- OTP policy ----------
export const OTP_TTL_MS = 5 * 60 * 1000;     // code valid 5 minutes
export const OTP_MAX_ATTEMPTS = 5;           // wrong-code tries before lockout
export const OTP_RESEND_LOCK_MS = 60 * 1000; // min seconds between SMS per phone

// Secret used to HMAC the OTP before storage. Falls back to the session secret
// (or a dev constant) so codes are never persisted in plaintext even locally.
function otpSecret(): string {
  return process.env.OTP_SECRET || process.env.SESSION_SECRET || "baltcircle-dev-otp-secret";
}

function hashOtp(phone: string, code: string): string {
  // Bind the hash to the phone so a leaked hash can't be replayed against
  // another number, and so identical codes for different phones differ.
  return createHmac("sha256", otpSecret()).update(`${phone}:${code}`).digest("hex");
}

function generateOtp(): string {
  // 4-digit numeric code (1000–9999) — matches the SMS copy and UI input.
  return String(randomInt(1000, 10000));
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!hasPlus && digits.length === 11 && digits.startsWith("8")) {
    digits = "7" + digits.slice(1);
    return "+" + digits;
  }
  return hasPlus ? "+" + digits : digits;
}

// Temporary admin bootstrap. ADMIN_PHONE_NUMBERS is a comma-separated list of
// phone numbers (any format) that should be granted the admin role. Nothing is
// hardcoded: with the env unset the set is empty and no one is auto-promoted.
// Each entry is normalized the same way rider phones are, so "8…" / "+7…" /
// spaced forms all match. This is a stopgap until a proper role-admin UI exists.
function adminPhoneSet(): Set<string> {
  const raw = process.env.ADMIN_PHONE_NUMBERS || "";
  return new Set(
    raw
      .split(",")
      .map((p) => normalizePhone(p))
      .filter((p) => p.replace(/\D/g, "").length >= 10),
  );
}

export function isAdminPhone(phone: string): boolean {
  return adminPhoneSet().has(normalizePhone(phone));
}

// Resolve the role a user should currently have. The ADMIN_PHONE_NUMBERS env
// takes precedence so a phone added to the list is promoted on next lookup even
// if the stored row predates the list; otherwise the persisted role is used.
export function resolveRole(user: User): UserRole {
  if (isAdminPhone(user.phone)) return "admin";
  return (user.role as UserRole) ?? "rider";
}

export interface IStorage {
  // users
  getUser(id: string): Promise<User | undefined>;
  getUserByPhone(phone: string): Promise<User | undefined>;
  updateProfile(id: string, patch: UpdateProfileInput): Promise<{ user: User } | { error: string }>;
  // admin user management
  listUsers(): Promise<User[]>;
  setUserRole(id: string, role: UserRole): Promise<{ user: User } | { error: string }>;
  setUserBlocked(id: string, blocked: boolean, reason?: string): Promise<{ user: User } | { error: string }>;
  // OTP verification
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
  listAllSupportConversations(): Promise<AdminSupportConversationRow[]>;
  getSupportConversation(id: number): Promise<SupportConversation | undefined>;
  // bikes
  listBikes(opts?: { includeArchived?: boolean }): Promise<Bike[]>;
  getBike(id: string): Promise<Bike | undefined>;
  updateBike(id: string, patch: Partial<Bike>): Promise<Bike | undefined>;
  // bikes — admin CRUD (staff only)
  createBike(input: AdminCreateBikeInput): Promise<{ bike: Bike } | { error: string }>;
  adminUpdateBike(id: string, patch: AdminUpdateBikeInput): Promise<{ bike: Bike } | { error: string }>;
  archiveBike(id: string): Promise<{ bike: Bike } | { error: string }>;
  deleteBike(id: string): Promise<{ ok: true } | { error: string; archived?: Bike }>;
  // parkings
  listParkings(opts?: { includeInactive?: boolean; includeArchived?: boolean }): Promise<Parking[]>;
  getParking(id: string): Promise<Parking | undefined>;
  createParking(input: AdminCreateParkingInput): Promise<{ parking: Parking } | { error: string }>;
  updateParking(id: string, patch: AdminUpdateParkingInput): Promise<{ parking: Parking } | { error: string }>;
  archiveParking(id: string): Promise<{ parking: Parking } | { error: string }>;
  restoreParking(id: string): Promise<{ parking: Parking } | { error: string }>;
  deleteParking(id: string): Promise<{ ok: true } | { error: string; archived?: Parking }>;
  // zones
  listZones(): Promise<ZoneRow[]>;
  // rides
  startRide(input: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }): Promise<Ride | { error: string }>;
  appendRidePoint(rideId: number, x: number, y: number): Promise<Ride | undefined>;
  endRide(rideId: number): Promise<Ride | undefined>;
  getRide(rideId: number): Promise<Ride | undefined>;
  getActiveRide(userId: string): Promise<Ride | undefined>;
  listRides(opts?: { userId?: string; limit?: number }): Promise<Ride[]>;
  listAdminRides(opts?: { limit?: number }): Promise<AdminRide[]>;
  // payments / wallet
  getWallet(userId: string): Promise<Wallet>;
  topUp(userId: string, amount: number): Promise<{ wallet: Wallet; payment: Payment }>;
  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number): Promise<{ wallet: Wallet; payment: Payment }>;
  listPayments(userId: string): Promise<Payment[]>;
  // service / maintenance tickets
  listTickets(): Promise<Ticket[]>;
  getTicket(id: number): Promise<TicketWithComments | undefined>;
  createTicket(input: CreateTicketInput): Promise<TicketWithComments>;
  updateTicket(id: number, patch: UpdateTicketInput, actor: string): Promise<TicketWithComments | undefined>;
  addTicketComment(id: number, author: string, body: string): Promise<TicketWithComments | undefined>;
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
  // analytics
  analytics(): Promise<any>;
  // period-scoped analytics for the admin "Аналитика v1" page
  adminAnalytics(range: { from: number; to: number }): Promise<any>;
}

export class DatabaseStorage implements IStorage {
  // ---------- Bikes read cache ----------
  // The public bike list drives the map and is polled/streamed by every
  // viewer, but the underlying rows change rarely (only on ride start/point/
  // end and admin edits). A tiny in-memory TTL cache absorbs the read storm:
  // one DB round-trip refreshes many concurrent readers. Any bike mutation
  // calls invalidateBikesCache() so a stale list is never served past a real
  // change. Only the full row set is cached; per-opts filtering stays cheap.
  private static readonly BIKES_CACHE_TTL_MS = 3000;
  private _bikesCache: Bike[] | null = null;
  private _bikesCacheAt = 0;

  // Drop the cached bike rows so the next listBikes() re-reads from the DB.
  // Call after ANY write that can change a bike's row (status/position/CRUD).
  invalidateBikesCache(): void {
    this._bikesCache = null;
    this._bikesCacheAt = 0;
  }

  // Apply the env-driven admin override so callers always see the effective
  // role without each one re-checking ADMIN_PHONE_NUMBERS.
  private withResolvedRole(user: User | undefined): User | undefined {
    if (!user) return user;
    return { ...user, role: resolveRole(user) };
  }

  async getUser(id: string) {
    const u = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0] as User | undefined;
    return this.withResolvedRole(u);
  }

  async getUserByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    const u = (await db.select().from(users).where(eq(users.phone, normalized)).limit(1))[0] as User | undefined;
    return this.withResolvedRole(u);
  }

  // Self-service profile update for the current user. Only name/email are
  // mutable here; phone changes must go through SMS OTP (not this endpoint).
  async updateProfile(id: string, patch: UpdateProfileInput) {
    const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0] as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };

    const set: Partial<User> = { updatedAt: Date.now() };
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.email !== undefined) {
      const email = patch.email.trim();
      set.email = email.length > 0 ? email : null;
    }
    await db.update(users).set(set as any).where(eq(users.id, id));
    return { user: (await this.getUser(id))! };
  }

  // ---------- Admin user management ----------
  // List every registered user, newest first, with effective roles applied so
  // the admin table shows the same role the rest of the app enforces (the
  // ADMIN_PHONE_NUMBERS override can make a stored "rider" effectively admin).
  async listUsers() {
    const rows = (await db.select().from(users).orderBy(desc(users.createdAt))) as User[];
    return rows.map((u) => this.withResolvedRole(u)!);
  }

  async setUserRole(id: string, role: UserRole) {
    const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0] as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };
    await db.update(users).set({ role, updatedAt: Date.now() } as any).where(eq(users.id, id));
    return { user: (await this.getUser(id))! };
  }

  async setUserBlocked(id: string, blocked: boolean, reason?: string) {
    const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0] as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };
    const set: Partial<User> = {
      blockedAt: blocked ? Date.now() : null,
      blockedReason: blocked ? (reason?.trim() || null) : null,
      updatedAt: Date.now(),
    };
    await db.update(users).set(set as any).where(eq(users.id, id));
    return { user: (await this.getUser(id))! };
  }

  // ---------- OTP verification ----------
  // Step 1: create/refresh a pending code for this phone and hand the plaintext
  // back to the caller so it can be dispatched via SMS. The code itself is only
  // stored as an HMAC. Enforces a per-phone resend lock.
  async startOtp({ name, phone }: { name: string; phone: string }) {
    const cleanName = name.trim();
    const cleanPhone = normalizePhone(phone);
    const digits = cleanPhone.replace(/\D/g, "");
    if (cleanName.length < 2) return { error: "Имя должно содержать минимум 2 символа" };
    if (digits.length < 10) return { error: "Введите корректный номер телефона" };

    const now = Date.now();
    const existing = (await db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).limit(1))[0] as OtpRequest | undefined;

    if (existing && !existing.consumed) {
      const sinceLast = now - existing.lastSentAt;
      if (sinceLast < OTP_RESEND_LOCK_MS) {
        const retryAfterSec = Math.ceil((OTP_RESEND_LOCK_MS - sinceLast) / 1000);
        return {
          error: `Повторная отправка кода будет доступна через ${retryAfterSec} с`,
          retryAfterSec,
        };
      }
    }

    const code = generateOtp();
    const codeHash = hashOtp(cleanPhone, code);
    const expiresAt = now + OTP_TTL_MS;

    await db.insert(otpRequests)
      .values({ phone: cleanPhone, name: cleanName, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: otpRequests.phone,
        set: { name: cleanName, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      });

    return { ok: true as const, phone: cleanPhone, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  // Step 2: verify a submitted code. On success the rider is created (or reused
  // if the phone already registered) and the request row is consumed.
  async verifyOtp({ phone, code, consentIp }: { phone: string; code: string; consentIp?: string }) {
    const cleanPhone = normalizePhone(phone);
    const req = (await db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).limit(1))[0] as OtpRequest | undefined;

    if (!req || req.consumed) {
      return { error: "Запросите код подтверждения заново" };
    }
    if (Date.now() > req.expiresAt) {
      return { error: "Срок действия кода истёк. Запросите новый код" };
    }
    if (req.attempts >= OTP_MAX_ATTEMPTS) {
      return { error: "Слишком много попыток. Запросите новый код" };
    }

    const expected = req.codeHash;
    const provided = hashOtp(cleanPhone, code.trim());
    if (!safeEqualHex(provided, expected)) {
      const attempts = req.attempts + 1;
      await db.update(otpRequests).set({ attempts }).where(eq(otpRequests.phone, cleanPhone));
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Correct code — consume the request so it can't be reused.
    await db.update(otpRequests).set({ consumed: true }).where(eq(otpRequests.phone, cleanPhone));

    // Consent was accepted at OTP start (the API requires consent: true before
    // a code is sent), so record the consent metadata on verify when the rider
    // row is created/refreshed. The verified phone IS the proof of consent.
    const now = Date.now();
    const role: UserRole = isAdminPhone(cleanPhone) ? "admin" : "rider";

    // Reuse an existing rider for this phone (keeps rides/wallet) or create one.
    const existing = (await db.select().from(users).where(eq(users.phone, cleanPhone)).limit(1))[0] as
      | User
      | undefined;
    if (existing) {
      const set: Partial<User> = {
        updatedAt: now,
        consentAcceptedAt: now,
        consentVersion: CONSENT_VERSION,
        consentIp: consentIp ?? existing.consentIp ?? null,
        // Keep an already-elevated role (e.g. operator) but ensure admin phones
        // are promoted. Never silently demote a stored operator/admin.
        role: role === "admin" ? "admin" : (existing.role as UserRole),
      };
      if (existing.name !== req.name) set.name = req.name;
      await db.update(users).set(set as any).where(eq(users.id, existing.id));
      return { user: (await this.getUser(existing.id))! };
    }
    await db.insert(users).values({
      id: randomUUID(),
      name: req.name,
      phone: cleanPhone,
      email: null,
      role,
      consentAcceptedAt: now,
      consentVersion: CONSENT_VERSION,
      consentIp: consentIp ?? null,
      createdAt: now,
      updatedAt: now,
    } as any);
    return { user: (await this.getUserByPhone(cleanPhone))! };
  }

  // ---------- OTP delivery diagnostics ----------
  // Persist the provider id/status returned when an OTP SMS was accepted (or the
  // safe error when it was not). Keyed by phone, matching the single pending OTP
  // row. A no-op if the row was already consumed/removed by a concurrent verify.
  async recordOtpSend({ phone, provider, providerMessageId, providerStatus, providerError }: {
    phone: string;
    provider?: string;
    providerMessageId?: string;
    providerStatus?: string;
    providerError?: string;
  }) {
    const cleanPhone = normalizePhone(phone);
    await db.update(otpRequests)
      .set({
        provider: provider ?? null,
        providerMessageId: providerMessageId ?? null,
        providerStatus: providerStatus ?? null,
        providerError: providerError ?? null,
        providerCheckedAt: Date.now(),
      })
      .where(eq(otpRequests.phone, cleanPhone));
  }

  // Read the latest OTP request row for a phone (includes provider diagnostics).
  async getLastOtpSend(phone: string): Promise<OtpRequest | undefined> {
    const cleanPhone = normalizePhone(phone);
    return (await db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).limit(1))[0] as OtpRequest | undefined;
  }

  // Update only the provider delivery status/error after a status refresh. Does
  // not touch the OTP lifecycle fields (code/expiry/attempts/consumed).
  async updateOtpProviderStatus({ phone, providerStatus, providerError }: {
    phone: string;
    providerStatus?: string;
    providerError?: string;
  }) {
    const cleanPhone = normalizePhone(phone);
    await db.update(otpRequests)
      .set({
        providerStatus: providerStatus ?? null,
        providerError: providerError ?? null,
        providerCheckedAt: Date.now(),
      })
      .where(eq(otpRequests.phone, cleanPhone));
  }

  // ---------- Phone change (SMS OTP, existing account) ----------
  // Step 1: a logged-in rider requests a code sent to a NEW number. The pending
  // request is keyed by the user id and stores the target phone; the code is
  // stored only as an HMAC. Enforces the same per-request resend lock as
  // registration and refuses a number already used by another account.
  async startPhoneChange({ userId, phone }: { userId: string; phone: string }) {
    const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0] as User | undefined;
    if (!user) return { error: "Пользователь не найден" };

    const newPhone = normalizePhone(phone);
    const digits = newPhone.replace(/\D/g, "");
    if (digits.length < 10) return { error: "Введите корректный номер телефона" };
    if (newPhone === user.phone) return { error: "Это уже ваш текущий номер" };

    // Don't allow merging into another account's number.
    const taken = (await db.select().from(users).where(eq(users.phone, newPhone)).limit(1))[0] as User | undefined;
    if (taken && taken.id !== userId) {
      return { error: "Этот номер уже используется другим аккаунтом" };
    }

    const now = Date.now();
    const existing = (await db.select().from(phoneChangeRequests)
      .where(eq(phoneChangeRequests.userId, userId)).limit(1))[0] as PhoneChangeRequest | undefined;
    if (existing && !existing.consumed) {
      const sinceLast = now - existing.lastSentAt;
      if (sinceLast < OTP_RESEND_LOCK_MS) {
        const retryAfterSec = Math.ceil((OTP_RESEND_LOCK_MS - sinceLast) / 1000);
        return { error: `Повторная отправка кода будет доступна через ${retryAfterSec} с`, retryAfterSec };
      }
    }

    const code = generateOtp();
    const codeHash = hashOtp(newPhone, code);
    const expiresAt = now + OTP_TTL_MS;
    await db.insert(phoneChangeRequests)
      .values({ userId, newPhone, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: phoneChangeRequests.userId,
        set: { newPhone, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      });

    return { ok: true as const, phone: newPhone, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  // Step 2: verify the code sent to the new number and, on success, update the
  // user's phone. The request row is consumed so the code can't be reused.
  async verifyPhoneChange({ userId, code }: { userId: string; code: string }) {
    const req = (await db.select().from(phoneChangeRequests)
      .where(eq(phoneChangeRequests.userId, userId)).limit(1))[0] as PhoneChangeRequest | undefined;
    if (!req || req.consumed) return { error: "Запросите код подтверждения заново" };
    if (Date.now() > req.expiresAt) return { error: "Срок действия кода истёк. Запросите новый код" };
    if (req.attempts >= OTP_MAX_ATTEMPTS) return { error: "Слишком много попыток. Запросите новый код" };

    const provided = hashOtp(req.newPhone, code.trim());
    if (!safeEqualHex(provided, req.codeHash)) {
      const attempts = req.attempts + 1;
      await db.update(phoneChangeRequests).set({ attempts }).where(eq(phoneChangeRequests.userId, userId));
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Re-check the number is still free (another account could have claimed it
    // between request and verify), then apply the change.
    const taken = (await db.select().from(users).where(eq(users.phone, req.newPhone)).limit(1))[0] as User | undefined;
    if (taken && taken.id !== userId) {
      return { error: "Этот номер уже используется другим аккаунтом" };
    }

    await db.update(phoneChangeRequests).set({ consumed: true }).where(eq(phoneChangeRequests.userId, userId));
    await db.update(users).set({ phone: req.newPhone, updatedAt: Date.now() } as any).where(eq(users.id, userId));
    return { user: (await this.getUser(userId))! };
  }

  // ---------- Payment methods (MVP metadata only) ----------
  async listPaymentMethods(userId: string) {
    return (await db.select().from(paymentMethods)
      .where(eq(paymentMethods.userId, userId))
      .orderBy(desc(paymentMethods.createdAt))) as PaymentMethod[];
  }

  // Link a method. Label/status are derived server-side so no card data can be
  // injected via the client. A masked test pan is used for "card" — never a
  // real number — and a fixed label for SBP.
  async linkPaymentMethod(userId: string, type: "card" | "sbp") {
    const label = type === "card" ? "•••• 4242" : "СБП";
    return (await db.insert(paymentMethods).values({
      userId, type, label, status: "linked", createdAt: Date.now(),
    }).returning())[0] as PaymentMethod;
  }

  async unlinkPaymentMethod(userId: string, id: number) {
    const res = await db.delete(paymentMethods)
      .where(sql`${paymentMethods.id} = ${id} AND ${paymentMethods.userId} = ${userId}`);
    return (res.rowCount ?? 0) > 0;
  }

  // ---------- T-Bank card binding (real acquiring metadata) ----------
  // Create a pending card method when a binding flow starts. The card is not
  // usable until the notification confirms it (status -> active) and fills in
  // CardId/RebillId. No card data is ever stored here.
  async createPendingCardMethod(input: { userId: string; customerKey: string; requestKey?: string }) {
    const now = Date.now();
    return (await db.insert(paymentMethods).values({
      userId: input.userId,
      type: "card",
      label: "Карта (привязывается…)",
      status: "pending",
      provider: "tbank",
      customerKey: input.customerKey,
      requestKey: input.requestKey ?? null,
      createdAt: now,
      updatedAt: now,
    } as any).returning())[0] as PaymentMethod;
  }

  // Create a pending card method backed by an Init+Recurrent verification
  // payment (the primary binding path). Stores our OrderId + amount so the
  // notification webhook can correlate the payment back to this row. The card is
  // not usable until the payment is CONFIRMED/AUTHORIZED with a RebillId. No card
  // data is ever stored here — the PAN/CVC live only on T-Bank's hosted form.
  async createPendingBindPayment(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    amountKopecks: number;
  }) {
    const now = Date.now();
    return (await db.insert(paymentMethods).values({
      userId: input.userId,
      type: "card",
      label: "Карта (привязывается…)",
      status: "pending",
      provider: "tbank",
      purpose: "card_binding",
      customerKey: input.customerKey,
      orderId: input.orderId,
      amountKopecks: input.amountKopecks,
      createdAt: now,
      updatedAt: now,
    } as any).returning())[0] as PaymentMethod;
  }

  // Create a pending SBP account binding (AddAccountQr). The account is not
  // usable until the payer authorises it in their bank and T-Bank returns an
  // AccountToken (via notification or GetAddAccountQrState). We store the
  // RequestKey + OrderId so either path can correlate back to this row. No
  // account/card data is ever stored — only the opaque provider identifiers.
  async createPendingSbpBinding(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    requestKey?: string;
  }) {
    const now = Date.now();
    return (await db.insert(paymentMethods).values({
      userId: input.userId,
      type: "sbp",
      label: "СБП (привязывается…)",
      status: "pending",
      provider: "tbank",
      purpose: "sbp_binding",
      customerKey: input.customerKey,
      orderId: input.orderId,
      requestKey: input.requestKey ?? null,
      createdAt: now,
      updatedAt: now,
    } as any).returning())[0] as PaymentMethod;
  }

  async getPaymentMethod(id: number) {
    return (await db.select().from(paymentMethods).where(eq(paymentMethods.id, id)).limit(1))[0] as
      | PaymentMethod
      | undefined;
  }

  // The most recent pending T-Bank card binding for a user. Used by the
  // notification handler to attach the confirmed card to the binding the rider
  // just started.
  async findPendingCardMethod(userId: string) {
    return (await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'pending'`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined;
  }

  // Locate a T-Bank card-binding method by the Init OrderId echoed back in the
  // payment notification. This is how the webhook correlates a verification
  // payment to the pending method (the Init flow has no RequestKey).
  async findCardMethodByOrderId(orderId: string) {
    return (await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.provider} = 'tbank' AND ${paymentMethods.orderId} = ${orderId}`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined;
  }

  // Locate a user's T-Bank card method by its AddCard RequestKey. Used to
  // resolve the method a rider was redirected back from (the Success/Fail URL
  // carries the RequestKey) so we can refresh exactly that binding.
  async findCardMethodByRequestKey(userId: string, requestKey: string) {
    return (await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.requestKey} = ${requestKey}`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined;
  }

  // Locate any T-Bank method by RequestKey alone (no user scope). The SBP
  // binding notification carries a RequestKey but not our user id, so this is
  // how the webhook attaches the AccountToken to the right pending row.
  async findMethodByRequestKey(requestKey: string) {
    return (await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.provider} = 'tbank' AND ${paymentMethods.requestKey} = ${requestKey}`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined;
  }

  // Resolve the rider's saved SBP account eligible for a recurring charge: an
  // active sbp-type method with an AccountToken. Mirrors getActiveSavedCard.
  async getActiveSavedSbp(userId: string, paymentMethodId?: number) {
    if (paymentMethodId != null) {
      const m = await this.getPaymentMethod(paymentMethodId);
      if (!m || m.userId !== userId) return undefined;
      if (m.provider !== "tbank" || m.status !== "active" || !m.accountToken) return undefined;
      return m;
    }
    return (await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'active' AND ${paymentMethods.accountToken} IS NOT NULL AND ${paymentMethods.accountToken} != ''`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined;
  }

  async updatePaymentMethod(id: number, patch: Partial<PaymentMethod>) {
    const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
    delete set.id;
    await db.update(paymentMethods).set(set as any).where(eq(paymentMethods.id, id));
    return this.getPaymentMethod(id);
  }

  // ---------- T-Bank ordinary ride payment orders ----------
  // Create a pending ride payment order when the rider starts the pay-then-ride
  // flow. The ride is NOT started until the payment is confirmed by the
  // notification webhook (status -> paid, ride_id filled). No card data is ever
  // stored here — the PAN/CVC live only on T-Bank's hosted form.
  async createRidePaymentOrder(input: {
    orderId: string;
    userId: string;
    bikeId: string;
    tariffId: string;
    amountKopecks: number;
    // "hosted" (default) for the hosted-form path; "saved_card" for a recurring
    // charge against a stored RebillId.
    source?: "hosted" | "saved_card";
    paymentMethodId?: number;
    rebillId?: string;
  }) {
    const now = Date.now();
    return (await db.insert(paymentOrders).values({
      orderId: input.orderId,
      userId: input.userId,
      bikeId: input.bikeId,
      tariffId: input.tariffId,
      amountKopecks: input.amountKopecks,
      source: input.source ?? "hosted",
      paymentMethodId: input.paymentMethodId ?? null,
      rebillId: input.rebillId ?? null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    } as any).returning())[0] as PaymentOrder;
  }

  // Resolve the rider's saved T-Bank card eligible for a recurring charge: an
  // active card-type method with a RebillId. When paymentMethodId is given it
  // must belong to the rider and be active with a RebillId; otherwise the most
  // recent qualifying card is returned. Returns undefined when no usable saved
  // card exists (the caller then falls back to the hosted payment flow).
  async getActiveSavedCard(userId: string, paymentMethodId?: number) {
    if (paymentMethodId != null) {
      const m = await this.getPaymentMethod(paymentMethodId);
      if (!m || m.userId !== userId) return undefined;
      if (m.provider !== "tbank" || m.status !== "active" || !m.rebillId) return undefined;
      return m;
    }
    return (await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'active' AND ${paymentMethods.rebillId} IS NOT NULL AND ${paymentMethods.rebillId} != ''`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined;
  }

  async getRidePaymentOrder(orderId: string) {
    return (await db.select().from(paymentOrders)
      .where(eq(paymentOrders.orderId, orderId))
      .limit(1))[0] as PaymentOrder | undefined;
  }

  async updateRidePaymentOrder(id: number, patch: Partial<PaymentOrder>) {
    const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
    delete set.id;
    await db.update(paymentOrders).set(set as any).where(eq(paymentOrders.id, id));
    return (await db.select().from(paymentOrders).where(eq(paymentOrders.id, id)).limit(1))[0] as
      | PaymentOrder
      | undefined;
  }

  // ---------- Support tickets ----------
  async listSupportTickets(userId: string) {
    return (await db.select().from(supportTickets)
      .where(eq(supportTickets.userId, userId))
      .orderBy(desc(supportTickets.createdAt))) as SupportTicket[];
  }

  async createSupportTicket({ userId, subject, message }: { userId: string; subject: string; message: string }) {
    return (await db.insert(supportTickets).values({
      userId, subject: subject.trim(), message: message.trim(), status: "open", createdAt: Date.now(),
    }).returning())[0] as SupportTicket;
  }

  // Staff inbox: every rider request across the platform, newest first, with
  // a light join on users so the operator sees who submitted the ticket.
  async listAllSupportTickets(): Promise<SupportTicketWithUser[]> {
    const rows = await db
      .select({
        id: supportTickets.id,
        userId: supportTickets.userId,
        subject: supportTickets.subject,
        message: supportTickets.message,
        status: supportTickets.status,
        createdAt: supportTickets.createdAt,
        userName: users.name,
        userPhone: users.phone,
      })
      .from(supportTickets)
      .leftJoin(users, eq(users.id, supportTickets.userId))
      .orderBy(desc(supportTickets.createdAt));
    return rows as SupportTicketWithUser[];
  }

  async updateSupportTicket(id: number, patch: { status?: SupportTicketStatus }): Promise<SupportTicket | undefined> {
    if (!patch.status) return this.getSupportTicket(id);
    const updated = (await db
      .update(supportTickets)
      .set({ status: patch.status })
      .where(eq(supportTickets.id, id))
      .returning())[0] as SupportTicket | undefined;
    return updated;
  }

  private async getSupportTicket(id: number): Promise<SupportTicket | undefined> {
    return (await db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1))[0] as SupportTicket | undefined;
  }

  // -------------------- SUPPORT CHAT (единый чат на пользователя) --------------------

  /** Get or lazily create a conversation for the given rider. */
  async ensureSupportConversation(userId: string): Promise<SupportConversation> {
    const existing = (await db.select().from(supportConversations)
      .where(eq(supportConversations.userId, userId)).limit(1))[0] as SupportConversation | undefined;
    if (existing) return existing;
    return (await db.insert(supportConversations).values({
      userId, createdAt: Date.now(), userUnreadCount: 0, operatorUnreadCount: 0,
    }).returning())[0] as SupportConversation;
  }

  /** Retrieve chat history for a conversation, oldest first (chronological). */
  async listSupportMessages(conversationId: number, opts?: { afterId?: number; limit?: number }): Promise<SupportMessage[]> {
    const conds: any[] = [eq(supportMessages.conversationId, conversationId)];
    if (opts?.afterId && Number.isFinite(opts.afterId)) {
      conds.push(gt(supportMessages.id, opts.afterId));
    }
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
    return (await db.select().from(supportMessages)
      .where(conds.length > 1 ? and(...conds) : conds[0])
      .orderBy(asc(supportMessages.id))
      .limit(limit)) as SupportMessage[];
  }

  /** Append a message, bump last_message_at, increment recipient's unread counter. */
  async appendSupportMessage(input: {
    conversationId: number;
    senderRole: SupportMessageRole;
    senderId: string | null;
    body: string;
    attachmentUrl?: string | null;
    attachmentMime?: string | null;
  }): Promise<SupportMessage> {
    const now = Date.now();
    const inserted = (await db.insert(supportMessages).values({
      conversationId: input.conversationId,
      senderRole: input.senderRole,
      senderId: input.senderId,
      body: (input.body ?? "").trim(),
      attachmentUrl: input.attachmentUrl ?? null,
      attachmentMime: input.attachmentMime ?? null,
      createdAt: now,
    }).returning())[0] as SupportMessage;

    // Бампаем счётчик непрочитанного у противоположной стороны + last_message_at
    if (input.senderRole === "user") {
      await db.execute(sql`
        UPDATE support_conversations
        SET last_message_at = ${now}, operator_unread_count = operator_unread_count + 1
        WHERE id = ${input.conversationId}
      `);
    } else if (input.senderRole === "operator") {
      await db.execute(sql`
        UPDATE support_conversations
        SET last_message_at = ${now}, user_unread_count = user_unread_count + 1
        WHERE id = ${input.conversationId}
      `);
    } else {
      await db.execute(sql`
        UPDATE support_conversations
        SET last_message_at = ${now}
        WHERE id = ${input.conversationId}
      `);
    }
    return inserted;
  }

  /** Zero-out unread counter for the reader side. */
  async markSupportRead(conversationId: number, reader: "user" | "operator"): Promise<void> {
    const col = reader === "user" ? "user_unread_count" : "operator_unread_count";
    await db.execute(sql.raw(
      `UPDATE support_conversations SET ${col} = 0 WHERE id = ${Number(conversationId)}`
    ));
  }

  /** Admin inbox: all conversations, newest activity first, joined with rider profile. */
  async listAllSupportConversations(): Promise<AdminSupportConversationRow[]> {
    const rows = await db.execute(sql`
      SELECT
        c.id, c.user_id AS "userId", c.last_message_at AS "lastMessageAt",
        c.user_unread_count AS "userUnreadCount",
        c.operator_unread_count AS "operatorUnreadCount",
        c.created_at AS "createdAt",
        u.name AS "userName", u.phone AS "userPhone",
        (
          SELECT COALESCE(NULLIF(m.body, ''), CASE WHEN m.attachment_url IS NOT NULL THEN '[вложение]' ELSE NULL END)
          FROM support_messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.id DESC LIMIT 1
        ) AS "lastMessagePreview"
      FROM support_conversations c
      LEFT JOIN users u ON u.id = c.user_id
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
    `);
    return (rows as any).rows as AdminSupportConversationRow[];
  }

  async getSupportConversation(id: number): Promise<SupportConversation | undefined> {
    return (await db.select().from(supportConversations)
      .where(eq(supportConversations.id, id)).limit(1))[0] as SupportConversation | undefined;
  }

  // Public list excludes archived (retired) bikes so they never appear on the
  // map or in rental selection. Admin callers pass includeArchived to see all.
  async listBikes(opts?: { includeArchived?: boolean }) {
    const now = Date.now();
    let rows = this._bikesCache;
    if (!rows || now - this._bikesCacheAt >= DatabaseStorage.BIKES_CACHE_TTL_MS) {
      rows = (await db.select().from(bikes)) as Bike[];
      this._bikesCache = rows;
      this._bikesCacheAt = now;
    }
    if (opts?.includeArchived) return rows;
    return rows.filter((b) => b.status !== "archived");
  }
  async getBike(id: string) { return (await db.select().from(bikes).where(eq(bikes.id, id)).limit(1))[0] as Bike | undefined; }
  async updateBike(id: string, patch: Partial<Bike>) {
    await db.update(bikes).set(patch as any).where(eq(bikes.id, id));
    this.invalidateBikesCache();
    return this.getBike(id);
  }

  // ---------- Bikes: admin CRUD (staff only) ----------
  // Normalize an optional string field: trim, and treat "" as null so blank
  // form inputs clear the column rather than storing an empty string.
  private optStr(v: string | undefined): string | null {
    if (v === undefined) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  }

  // Create a real (non-demo) bike. The id is unique (primary key); a duplicate
  // is rejected with a clear message. Map coordinates default to the assigned
  // parking station or the map centre so the bike has a valid position.
  async createBike(input: AdminCreateBikeInput) {
    const id = input.id.trim().toUpperCase();
    if (await this.getBike(id)) return { error: "Велосипед с таким кодом уже существует" };

    let lat = MAP_H / 2;
    let lng = MAP_W / 2;
    const parkingId = this.optStr(input.parkingId);
    if (parkingId) {
      const p = (await db.select().from(parkings).where(eq(parkings.id, parkingId)).limit(1))[0] as Parking | undefined;
      if (p) { lat = p.lat; lng = p.lng; }
    }

    const now = Date.now();
    await db.insert(bikes).values({
      id,
      model: input.model.trim(),
      status: input.status,
      battery: input.battery,
      lat, lng,
      lastSeen: now,
      idleHours: 0,
      flagged: false,
      serial: this.optStr(input.serial),
      lockId: this.optStr(input.lockId),
      parkingId,
      notes: this.optStr(input.notes),
      seed: false,
    } as any);
    this.invalidateBikesCache();
    return { bike: (await this.getBike(id))! };
  }

  async adminUpdateBike(id: string, patch: AdminUpdateBikeInput) {
    const existing = await this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };

    const set: Partial<Bike> = {};
    if (patch.model !== undefined) set.model = patch.model.trim();
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.battery !== undefined) set.battery = patch.battery;
    if (patch.serial !== undefined) set.serial = this.optStr(patch.serial);
    if (patch.lockId !== undefined) set.lockId = this.optStr(patch.lockId);
    if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);
    if (patch.parkingId !== undefined) {
      const parkingId = this.optStr(patch.parkingId);
      set.parkingId = parkingId;
    }
    await db.update(bikes).set(set as any).where(eq(bikes.id, id));
    this.invalidateBikesCache();
    return { bike: (await this.getBike(id))! };
  }

  // Soft delete: mark a bike archived so it drops out of the public list and
  // rental selection while keeping its ride history intact.
  async archiveBike(id: string) {
    const existing = await this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };
    if (existing.status === "rented") return { error: "Нельзя архивировать велосипед во время активной аренды" };
    await db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id));
    this.invalidateBikesCache();
    return { bike: (await this.getBike(id))! };
  }

  // Hard delete: only allowed when the bike has no ride history. Otherwise we
  // refuse and archive instead, so analytics/ride records never dangle.
  async deleteBike(id: string) {
    const existing = await this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };
    if (existing.status === "rented") return { error: "Нельзя удалить велосипед во время активной аренды" };
    const rideCount = Number((await pool.query("SELECT COUNT(*) AS c FROM rides WHERE bike_id = $1", [id])).rows[0].c);
    if (rideCount > 0) {
      await db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id));
      this.invalidateBikesCache();
      return { error: "У велосипеда есть история поездок — он переведён в архив", archived: (await this.getBike(id))! };
    }
    await db.delete(bikes).where(eq(bikes.id, id));
    this.invalidateBikesCache();
    return { ok: true as const };
  }
  // ---------- Parkings: read + admin CRUD ----------
  // Public callers get active, non-archived points only. The admin page passes
  // includeInactive/includeArchived to see the full set.
  async listParkings(opts?: { includeInactive?: boolean; includeArchived?: boolean }) {
    let rows = (await db.select().from(parkings)) as Parking[];
    if (!opts?.includeArchived) rows = rows.filter((p) => !p.archivedAt);
    if (!opts?.includeInactive) rows = rows.filter((p) => p.status === "active");
    return rows;
  }
  async getParking(id: string) {
    return (await db.select().from(parkings).where(eq(parkings.id, id)).limit(1))[0] as Parking | undefined;
  }

  // Generate the next free P-NN id when the operator doesn't supply one.
  private async nextParkingId(): Promise<string> {
    const ids = ((await db.select({ id: parkings.id }).from(parkings)) as { id: string }[]).map((r) => r.id);
    let n = 1;
    while (ids.includes(`P-${String(n).padStart(2, "0")}`)) n++;
    return `P-${String(n).padStart(2, "0")}`;
  }

  async createParking(input: AdminCreateParkingInput) {
    const id = (input.id && input.id.trim().length > 0 ? input.id.trim().toUpperCase() : await this.nextParkingId());
    if (await this.getParking(id)) return { error: "Парковка с таким кодом уже существует" };
    const now = Date.now();
    const occupied = Math.min(input.occupied, input.capacity);
    await db.insert(parkings).values({
      id,
      name: input.name.trim(),
      lat: input.lat,
      lng: input.lng,
      capacity: input.capacity,
      occupied,
      status: input.status,
      notes: this.optStr(input.notes),
      archivedAt: null,
      seed: false,
      createdAt: now,
      updatedAt: now,
    } as any);
    return { parking: (await this.getParking(id))! };
  }

  async updateParking(id: string, patch: AdminUpdateParkingInput) {
    const existing = await this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    const set: Partial<Parking> = {};
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.lat !== undefined) set.lat = patch.lat;
    if (patch.lng !== undefined) set.lng = patch.lng;
    if (patch.capacity !== undefined) set.capacity = patch.capacity;
    if (patch.occupied !== undefined) set.occupied = patch.occupied;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);
    // Keep occupied within the (possibly new) capacity bound.
    const cap = set.capacity ?? existing.capacity;
    const occ = set.occupied ?? existing.occupied;
    if (occ > cap) set.occupied = cap;
    set.updatedAt = Date.now();
    await db.update(parkings).set(set as any).where(eq(parkings.id, id));
    return { parking: (await this.getParking(id))! };
  }

  // Soft delete: stamp archivedAt so the point drops out of every list while
  // staying referenceable from bikes/history that point at its id.
  async archiveParking(id: string) {
    const existing = await this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    await db.update(parkings).set({ archivedAt: Date.now(), updatedAt: Date.now() } as any).where(eq(parkings.id, id));
    return { parking: (await this.getParking(id))! };
  }

  // Undo a soft delete: clear archivedAt and force status to inactive so the
  // point returns muted on the admin maps but never re-appears on the public
  // map until an operator explicitly re-activates it.
  async restoreParking(id: string) {
    const existing = await this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    if (!existing.archivedAt) return { error: "Парковка не в архиве" };
    await db.update(parkings).set({ archivedAt: null, status: "inactive", updatedAt: Date.now() } as any).where(eq(parkings.id, id));
    return { parking: (await this.getParking(id))! };
  }

  // Hard delete: only when no bike references this parking. Otherwise archive so
  // bike.parkingId never dangles.
  async deleteParking(id: string) {
    const existing = await this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    const refCount = Number((await pool.query("SELECT COUNT(*) AS c FROM bikes WHERE parking_id = $1", [id])).rows[0].c);
    if (refCount > 0) {
      await db.update(parkings).set({ archivedAt: Date.now(), updatedAt: Date.now() } as any).where(eq(parkings.id, id));
      return { error: "К парковке привязаны велосипеды — она переведена в архив", archived: (await this.getParking(id))! };
    }
    await db.delete(parkings).where(eq(parkings.id, id));
    return { ok: true as const };
  }

  async listZones() { return (await db.select().from(zones)) as ZoneRow[]; }

  // ---- ride GPS points (append-only, avoids O(N^2) track rewrites) ----
  // Live points go to their own ride_points table so each appended point is a
  // single INSERT instead of parsing + re-stringifying the whole track JSON.
  // rides.track stays the canonical stored track, finalised once in endRide.
  private async insertRidePoint(rideId: number, x: number, y: number, t: number) {
    await pool.query(
      "INSERT INTO ride_points (ride_id, x, y, t) VALUES ($1, $2, $3, $4)",
      [rideId, x, y, t],
    );
  }

  private async loadRidePoints(rideId: number): Promise<[number, number, number][]> {
    const rows = (await pool.query(
      "SELECT x, y, t FROM ride_points WHERE ride_id = $1 ORDER BY id",
      [rideId],
    )).rows as { x: number; y: number; t: number }[];
    return rows.map((p) => [p.x, p.y, p.t]);
  }

  // Return the ride with its live track hydrated from ride_points. Only active
  // rides read from ride_points (the authoritative live track); a finished
  // ride already has its track flushed into rides.track by endRide, so we leave
  // it untouched even though its point rows may linger.
  private async hydrateTrack(ride: Ride | undefined): Promise<Ride | undefined> {
    if (!ride) return ride;
    if (ride.status !== "active") return ride;
    const pts = await this.loadRidePoints(ride.id);
    if (pts.length === 0) return ride;
    return { ...ride, track: JSON.stringify(pts) };
  }

  async startRide({ bikeId, userId, tariff, prepaid }: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }) {
    // Hourly, prepaid model: the rider picks an hourly tariff (h1/h2/h3) and
    // pays its full price UP FRONT. The ride's cost is fixed to the tariff
    // price at start (in kopecks); endRide only adds an overage charge if the
    // rider exceeds the paid window (auto-extension). There is no per-minute
    // accrual any more.
    //
    // Two payment paths:
    //   - prepaid = true  -> the rider already paid on T-Bank's hosted/recurring
    //     flow (ride/init). The wallet must NOT be charged again here.
    //   - prepaid = false -> internal/demo flow: charge the tariff price from
    //     the wallet balance atomically as part of starting the ride.
    const tariffDef = TARIFFS.find((t) => t.id === tariff);
    const costKopecks = tariffDef ? tariffPriceKopecks(tariffDef) : 0;

    // Atomic: re-check the bike/rider state and claim the bike inside ONE
    // transaction. Without this, two concurrent requests could both pass the
    // availability/active-ride checks and each insert a ride for the same bike
    // (double-booking). The transaction serialises the check-and-claim so the
    // second caller sees the bike already "rented" / the rider already riding.
    const result = await db.transaction(async (tx) => {
      const bike = (await tx.select().from(bikes).where(eq(bikes.id, bikeId)).limit(1))[0] as Bike | undefined;
      if (!bike) return { error: "Велосипед не найден" };
      if (bike.status !== "available" && bike.status !== "reserved") {
        return { error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` };
      }
      if (bike.battery < 18) return { error: "Низкий заряд замка, выберите другой велосипед" };
      const active = (await tx.select().from(rides)
        .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
        .limit(1))[0] as Ride | undefined;
      if (active) return { error: "У вас уже есть активная поездка" };

      // Internal (non-prepaid) flow: debit the tariff price from the wallet up
      // front, inside the same transaction so a failure rolls the ride back.
      if (!prepaid && costKopecks > 0) {
        let w = (await tx.select().from(wallet).where(eq(wallet.userId, userId)).limit(1))[0] as Wallet | undefined;
        if (!w) {
          await tx.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any);
          w = { userId, balance: 0 } as Wallet;
        }
        if (w.balance < costKopecks) {
          return { error: "Недостаточно средств на балансе" };
        }
        await tx.update(wallet).set({ balance: w.balance - costKopecks }).where(eq(wallet.userId, userId));
        await tx.insert(payments).values({
          userId, amount: -costKopecks, kind: "ride_charge",
          description: `Аренда ${bikeId} • ${tariffDef?.name ?? tariff}`, createdAt: Date.now(),
        });
      }

      const startedAt = Date.now();
      const track: [number, number, number][] = [[bike.lng, bike.lat, startedAt]];
      const row = (await tx.insert(rides).values({
        bikeId, userId, startedAt,
        startLat: bike.lat, startLng: bike.lng,
        track: JSON.stringify(track), distanceM: 0, cost: costKopecks, tariff, status: "active",
      }).returning())[0] as Ride;
      await tx.update(bikes).set({ status: "rented", updatedAt: Date.now() } as any)
        .where(eq(bikes.id, bikeId));
      // Seed the append-only points table with the start point so the live
      // track (hydrated from ride_points) is never empty for a fresh ride.
      await tx.execute(sql`INSERT INTO ride_points (ride_id, x, y, t) VALUES (${row.id}, ${bike.lng}, ${bike.lat}, ${startedAt})`);
      return row;
    });
    // A successful start flipped a bike to "rented" → the public list is stale.
    // Only fire side effects on the success shape (a Ride row, not an error).
    if (result && !("error" in result)) {
      this.invalidateBikesCache();
      rideEvents.emit(userId, "start" as RideEventReason);
    }
    return result;
  }

  async appendRidePoint(rideId: number, x: number, y: number) {
    const r = (await db.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride | undefined;
    if (!r || r.status !== "active") return undefined;
    // Distance delta is computed from the LAST stored point only — a single
    // indexed row read, not a parse of the whole track. Then we append one row
    // instead of rewriting the entire track JSON (was O(N^2) per ride).
    const last = (await pool.query(
      "SELECT x, y, t FROM ride_points WHERE ride_id = $1 ORDER BY id DESC LIMIT 1",
      [rideId],
    )).rows[0] as { x: number; y: number; t: number } | undefined;
    const px = last ? last.x : r.startLng;
    const py = last ? last.y : r.startLat;
    const dx = x - px, dy = y - py;
    const dMap = Math.sqrt(dx * dx + dy * dy);
    // 1 map unit ≈ 30 metres (≈30km coastal span across 1000 units, demo scale)
    const addedMeters = dMap * 30;
    const newDistance = r.distanceM + addedMeters;
    await this.insertRidePoint(rideId, x, y, Date.now());
    // Hourly prepaid model: cost is fixed at start (tariff price) and only
    // changes on overage in endRide. Live points update the distance only —
    // never the price. rides.track is finalised once in endRide.
    await db.update(rides).set({ distanceM: newDistance }).where(eq(rides.id, rideId));
    await db.update(bikes).set({ lat: y, lng: x, lastSeen: Date.now(), idleHours: 0 } as any)
      .where(eq(bikes.id, r.bikeId));
    // Position changed → invalidate the map list and push the owning rider a
    // fresh active-ride snapshot (new track point) over SSE.
    this.invalidateBikesCache();
    rideEvents.emit(r.userId, "point" as RideEventReason);
    return this.hydrateTrack(
      (await db.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride,
    );
  }

  async endRide(rideId: number) {
    // Atomic: completing a ride touches four tables (ride, bike, wallet,
    // payment ledger). Doing them as separate statements risks a partial state
    // if the process dies mid-way — e.g. wallet debited but ride still active,
    // or bike freed without a charge recorded. One transaction keeps them
    // consistent: either the whole settlement lands or none of it does.
    const result = await db.transaction(async (tx) => {
      const r = (await tx.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride | undefined;
      if (!r || r.status !== "active") return undefined;
      // Flush the append-only points into the canonical rides.track ONCE, at
      // completion. Fall back to the legacy in-row track for rides that started
      // before the ride_points migration and never got any point rows.
      const pts: [number, number, number][] = await this.loadRidePoints(rideId);
      const track: [number, number, number][] =
        pts.length > 0 ? pts : (JSON.parse(r.track) as [number, number, number][]);
      const last = track[track.length - 1];
      const endedAt = Date.now();

      // Hourly prepaid model. The tariff was paid at start (r.cost holds the
      // prepaid tariff price, in kopecks). If the rider kept the bike past the
      // paid window, auto-extend by charging one OVERAGE_HOUR_PRICE per started
      // extra hour. Rides on an unknown/legacy tariff (durationHours unknown)
      // skip overage and just settle at the recorded cost.
      const tariffDef = TARIFFS.find((t) => t.id === r.tariff);
      const paidMs = (tariffDef?.durationHours ?? 0) * 60 * 60 * 1000;
      const usedMs = endedAt - r.startedAt;
      const { extraHours, overageKopecks } = computeOverage(usedMs, paidMs);
      const finalCost = finalRideCost(r.cost, overageKopecks);

      await tx.update(rides).set({
        endedAt, status: "completed", cost: finalCost,
        endLat: last[1], endLng: last[0],
        track: JSON.stringify(track),
      }).where(eq(rides.id, rideId));
      await tx.update(bikes).set({ status: "available", lat: last[1], lng: last[0], lastSeen: endedAt, idleHours: 0 } as any)
        .where(eq(bikes.id, r.bikeId));

      // Only the overage is charged at end — the base tariff was already paid at
      // start (wallet debit or T-Bank). Debit the wallet for the extra hours,
      // inside the same tx so it rolls back with everything else on failure.
      if (overageKopecks > 0) {
        let w = (await tx.select().from(wallet).where(eq(wallet.userId, r.userId)).limit(1))[0] as Wallet | undefined;
        if (!w) {
          await tx.insert(wallet).values({ userId: r.userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any);
          w = { userId: r.userId, balance: 0 } as Wallet;
        }
        await tx.update(wallet).set({ balance: w.balance - overageKopecks }).where(eq(wallet.userId, r.userId));
        await tx.insert(payments).values({
          userId: r.userId, amount: -overageKopecks, kind: "ride_charge",
          description: `Продление аренды ${r.bikeId} • +${extraHours} ч`, createdAt: endedAt,
        });
      }
      return (await tx.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride;
    });
    // Ended ride freed the bike (status "available") → refresh the map list and
    // push a terminal event so the rider's SSE stream sends null (ride over).
    if (result) {
      this.invalidateBikesCache();
      rideEvents.emit(result.userId, "end" as RideEventReason);
    }
    return result;
  }

  async getRide(rideId: number) {
    return this.hydrateTrack(
      (await db.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride | undefined,
    );
  }

  async getActiveRide(userId: string) {
    return this.hydrateTrack(
      (await db.select().from(rides)
        .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
        .limit(1))[0] as Ride | undefined,
    );
  }

  async listRides(opts?: { userId?: string; limit?: number }) {
    const limit = opts?.limit ?? 50;
    const rows = opts?.userId
      ? ((await db.select().from(rides)
          .where(eq(rides.userId, opts.userId))
          .orderBy(desc(rides.startedAt))
          .limit(limit)) as Ride[])
      : ((await db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit)) as Ride[]);
    return Promise.all(rows.map((r) => this.hydrateTrack(r))) as Promise<Ride[]>;
  }

  // Rides for the operator panel, newest first, joined to rider identity so the
  // admin table can show a name/phone instead of a raw user id. Riders are
  // looked up in a single batch; unknown/demo ids resolve to null so the UI can
  // fall back to the id.
  async listAdminRides(opts?: { limit?: number }) {
    const limit = opts?.limit ?? 200;
    const rows = (await db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit)) as Ride[];
    const all = (await db.select().from(users)) as User[];
    const byId = new Map(all.map((u) => [u.id, u]));
    return Promise.all(rows.map(async (r) => {
      const hydrated = (await this.hydrateTrack(r))!;
      const u = byId.get(hydrated.userId);
      return { ...hydrated, userName: u?.name ?? null, userPhone: u?.phone ?? null } as AdminRide;
    }));
  }

  async getWallet(userId: string) {
    let w = (await db.select().from(wallet).where(eq(wallet.userId, userId)).limit(1))[0] as Wallet | undefined;
    if (!w) {
      await db.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any);
      w = (await db.select().from(wallet).where(eq(wallet.userId, userId)).limit(1))[0] as Wallet;
    }
    return w;
  }

  async topUp(userId: string, amount: number) {
    const w = await this.getWallet(userId);
    const newBal = w.balance + amount;
    await db.update(wallet).set({ balance: newBal }).where(eq(wallet.userId, userId));
    const pay = (await db.insert(payments).values({
      userId, amount, kind: "topup",
      description: `Пополнение баланса карты •• 4242`, createdAt: Date.now(),
    }).returning())[0] as Payment;
    return { wallet: await this.getWallet(userId), payment: pay };
  }

  async purchaseTariff(userId: string, tariff: string, price: number, durationMs: number) {
    const w = await this.getWallet(userId);
    const newBal = w.balance - price;
    const expires = Date.now() + durationMs;
    await db.update(wallet).set({ balance: newBal, activeTariff: tariff, tariffExpiresAt: expires } as any)
      .where(eq(wallet.userId, userId));
    const pay = (await db.insert(payments).values({
      userId, amount: -price, kind: "tariff_purchase",
      description: `Подключён тариф «${tariff}»`, createdAt: Date.now(),
    }).returning())[0] as Payment;
    return { wallet: await this.getWallet(userId), payment: pay };
  }

  async listPayments(userId: string) {
    return (await db.select().from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt))) as Payment[];
  }

  async listTickets() { return (await db.select().from(tickets).orderBy(desc(tickets.createdAt))) as Ticket[]; }

  async getTicket(id: number): Promise<TicketWithComments | undefined> {
    const t = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0] as Ticket | undefined;
    if (!t) return undefined;
    const comments = (await db.select().from(ticketComments)
      .where(eq(ticketComments.ticketId, id))
      .orderBy(ticketComments.createdAt)) as TicketComment[];
    return { ...t, comments };
  }

  private async addEvent(ticketId: number, author: string, body: string, kind: "comment" | "event") {
    await db.insert(ticketComments).values({
      ticketId, author, body, kind, createdAt: Date.now(),
    });
  }

  async createTicket(input: CreateTicketInput): Promise<TicketWithComments> {
    const now = Date.now();
    const title = (input.title ?? "").trim();
    const assignee = (input.assignee ?? "").trim();
    const row = (await db.insert(tickets).values({
      bikeId: input.bikeId,
      kind: input.kind,
      priority: input.priority,
      title,
      message: input.message,
      assignee: assignee || null,
      status: "new",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    }).returning())[0] as Ticket;
    await this.addEvent(row.id, "Система", "Заявка создана", "event");

    // High/critical tickets pull a rentable bike out of rotation into
    // maintenance so it can't be rented while the issue is open. We never touch
    // a bike that's mid-ride (rented) or already out of service.
    if ((input.priority === "high" || input.priority === "critical")) {
      const bike = await this.getBike(input.bikeId);
      if (bike && (bike.status === "available" || bike.status === "reserved")) {
        await this.updateBike(bike.id, { status: "maintenance" });
        await this.addEvent(row.id, "Система", `Велосипед ${bike.id} переведён в обслуживание`, "event");
      }
    }
    return (await this.getTicket(row.id))!;
  }

  async updateTicket(id: number, patch: UpdateTicketInput, actor: string): Promise<TicketWithComments | undefined> {
    const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0] as Ticket | undefined;
    if (!existing) return undefined;
    const now = Date.now();
    const set: Partial<Ticket> = { updatedAt: now };

    if (patch.priority !== undefined && patch.priority !== existing.priority) {
      set.priority = patch.priority;
      await this.addEvent(id, actor, `Приоритет: ${existing.priority} → ${patch.priority}`, "event");
    }
    if (patch.assignee !== undefined) {
      const next = patch.assignee.trim() || null;
      if (next !== (existing.assignee ?? null)) {
        set.assignee = next;
        await this.addEvent(id, actor, next ? `Назначено: ${next}` : "Исполнитель снят", "event");
      }
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      set.status = patch.status;
      const becameClosed = TICKET_CLOSED_STATUSES.includes(patch.status);
      set.closedAt = becameClosed ? now : null;
      await this.addEvent(id, actor, `Статус: ${existing.status} → ${patch.status}`, "event");
    }

    await db.update(tickets).set(set as any).where(eq(tickets.id, id));

    // Optional action when closing: return the bike to the rental pool if it's
    // currently in maintenance because of this issue.
    if (patch.returnBikeToAvailable) {
      const bike = await this.getBike(existing.bikeId);
      if (bike && bike.status === "maintenance") {
        await this.updateBike(bike.id, { status: "available" });
        await this.addEvent(id, actor, `Велосипед ${bike.id} возвращён в доступные`, "event");
      }
    }
    return this.getTicket(id);
  }

  async addTicketComment(id: number, author: string, body: string): Promise<TicketWithComments | undefined> {
    const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0] as Ticket | undefined;
    if (!existing) return undefined;
    await this.addEvent(id, author, body, "comment");
    await db.update(tickets).set({ updatedAt: Date.now() }).where(eq(tickets.id, id));
    return this.getTicket(id);
  }

  async listMapObjects(opts?: { activeOnly?: boolean }) {
    const rows = (await db.select().from(mapObjects).orderBy(desc(mapObjects.createdAt))) as MapObject[];
    return opts?.activeOnly ? rows.filter((o) => o.active) : rows;
  }

  async createMapObject(input: InsertMapObject) {
    return (await db.insert(mapObjects).values({
      name: input.name,
      type: input.type,
      kind: input.kind,
      color: input.color,
      points: JSON.stringify(input.points),
      active: input.active,
      createdAt: Date.now(),
    }).returning())[0] as MapObject;
  }

  async setMapObjectActive(id: number, active: boolean) {
    return this.updateMapObject(id, { active });
  }

  async updateMapObject(id: number, patch: Partial<{
    name: string;
    type: "route" | "operating" | "slow" | "forbidden";
    kind: "route" | "zone";
    color: string;
    points: [number, number][];
    active: boolean;
  }>) {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.color !== undefined) set.color = patch.color;
    if (patch.points !== undefined) set.points = JSON.stringify(patch.points);
    if (patch.active !== undefined) set.active = patch.active;
    if (Object.keys(set).length === 0) {
      return (await db.select().from(mapObjects).where(eq(mapObjects.id, id)).limit(1))[0] as MapObject | undefined;
    }
    await db.update(mapObjects).set(set as any).where(eq(mapObjects.id, id));
    return (await db.select().from(mapObjects).where(eq(mapObjects.id, id)).limit(1))[0] as MapObject | undefined;
  }

  async deleteMapObject(id: number) {
    const res = await db.delete(mapObjects).where(eq(mapObjects.id, id));
    return (res.rowCount ?? 0) > 0;
  }

  async analytics() {
    const total = Number((await pool.query("SELECT COUNT(*) AS c FROM rides")).rows[0].c);
    const completed = Number((await pool.query("SELECT COUNT(*) AS c FROM rides WHERE status='completed'")).rows[0].c);
    const revenue = Number((await pool.query("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed'")).rows[0].s);
    const avgDuration = Number((await pool.query("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed'")).rows[0].a);
    const avgDistance = Number((await pool.query("SELECT COALESCE(AVG(distance_m),0) AS a FROM rides WHERE status='completed'")).rows[0].a);

    const byDay = (await pool.query(`
      SELECT to_char(to_timestamp(started_at/1000), 'YYYY-MM-DD') AS day,
             COUNT(*) AS rides_count,
             COALESCE(SUM(cost),0) AS revenue
      FROM rides
      GROUP BY day
      ORDER BY day DESC
      LIMIT 14
    `)).rows.reverse();

    // popular parkings — proximity of ride start
    const allParkings = await this.listParkings();
    const allRides = (await pool.query("SELECT start_lat, start_lng FROM rides")).rows as any[];
    const parkingCounts = allParkings.map(p => {
      let c = 0;
      for (const r of allRides) {
        const dx = r.start_lng - p.lng;
        const dy = r.start_lat - p.lat;
        if (Math.sqrt(dx*dx+dy*dy) < 30) c++;
      }
      return { ...p, rideStarts: c };
    }).sort((a, b) => b.rideStarts - a.rideStarts);

    const utilisation = (await pool.query(`
      SELECT bike_id, COUNT(*) AS rides
      FROM rides
      GROUP BY bike_id
      ORDER BY rides DESC
      LIMIT 8
    `)).rows;

    const problemBikes = (await pool.query(`
      SELECT * FROM bikes
      WHERE flagged = TRUE OR battery < 25 OR idle_hours > 60
      ORDER BY idle_hours DESC
      LIMIT 12
    `)).rows;

    const idleAvg = Number((await pool.query("SELECT AVG(idle_hours) AS a FROM bikes")).rows[0].a);

    return { total, completed, revenue, avgDuration, avgDistance, byDay, parkingCounts, utilisation, problemBikes, idleAvg };
  }

  // Period-scoped analytics powering the admin "Аналитика v1" page. Everything
  // is computed against rides that *started* within [from, to]. Revenue is the
  // sum of settled ride cost (the current ride/tariff data — no real acquiring).
  async adminAnalytics(range: { from: number; to: number }) {
    const { from, to } = range;
    const q1 = async (sqlStr: string) =>
      (await pool.query(sqlStr, [from, to])).rows[0] as any;

    // ---- KPI cards (selected period) ----
    const ridesCount = Number((await q1("SELECT COUNT(*) AS c FROM rides WHERE started_at >= $1 AND started_at <= $2")).c);
    const activeRides = Number((await q1("SELECT COUNT(*) AS c FROM rides WHERE status='active' AND started_at >= $1 AND started_at <= $2")).c);
    const completedRides = Number((await q1("SELECT COUNT(*) AS c FROM rides WHERE status='completed' AND started_at >= $1 AND started_at <= $2")).c);
    const revenue = Number((await q1("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed' AND started_at >= $1 AND started_at <= $2")).s);
    const avgDuration = Number((await q1("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed' AND ended_at IS NOT NULL AND started_at >= $1 AND started_at <= $2")).a);
    // Average check = revenue per completed (paid) ride in the period.
    const avgCheck = completedRides > 0 ? revenue / completedRides : 0;
    const newUsers = Number((await q1("SELECT COUNT(*) AS c FROM users WHERE created_at >= $1 AND created_at <= $2")).c);
    const usersWithRides = Number((await q1("SELECT COUNT(DISTINCT user_id) AS c FROM rides WHERE started_at >= $1 AND started_at <= $2")).c);
    const openTickets = Number((await pool.query(
      `SELECT COUNT(*) AS c FROM tickets WHERE status NOT IN ('resolved','closed','cancelled')`,
    )).rows[0].c);

    // ---- Rides per day (within the period) for the trend chart ----
    const byDay = (await pool.query(`
      SELECT to_char(to_timestamp(started_at/1000), 'YYYY-MM-DD') AS day,
             COUNT(*) AS rides_count,
             COALESCE(SUM(CASE WHEN status='completed' THEN cost ELSE 0 END),0) AS revenue
      FROM rides
      WHERE started_at >= $1 AND started_at <= $2
      GROUP BY day
      ORDER BY day ASC
    `, [from, to])).rows as any[];

    // ---- Top bikes (most rides) and zero-ride bikes in the period ----
    const ridesByBike = new Map<string, number>();
    for (const row of (await pool.query(
      "SELECT bike_id, COUNT(*) AS c FROM rides WHERE started_at >= $1 AND started_at <= $2 GROUP BY bike_id",
      [from, to],
    )).rows as any[]) {
      ridesByBike.set(row.bike_id, Number(row.c));
    }
    const liveBikes = await this.listBikes(); // excludes archived
    const topBikes = liveBikes
      .map((b) => ({ id: b.id, model: b.model, status: b.status, rides: ridesByBike.get(b.id) ?? 0 }))
      .sort((a, b) => b.rides - a.rides)
      .slice(0, 10);
    const zeroRideBikes = liveBikes
      .filter((b) => (ridesByBike.get(b.id) ?? 0) === 0)
      .map((b) => ({ id: b.id, model: b.model, status: b.status, idleHours: b.idleHours }))
      .sort((a, b) => b.idleHours - a.idleHours);

    // ---- Users summary ----
    const totalUsers = Number((await pool.query("SELECT COUNT(*) AS c FROM users")).rows[0].c);
    const blockedUsers = Number((await pool.query("SELECT COUNT(*) AS c FROM users WHERE blocked_at IS NOT NULL")).rows[0].c);
    const usersSummary = { total: totalUsers, newInPeriod: newUsers, withRidesInPeriod: usersWithRides, blocked: blockedUsers };

    // ---- Service stats (whole-fleet snapshot; tickets are operational, not period-bound) ----
    const ticketsByPriority = (await pool.query(
      "SELECT priority, COUNT(*) AS c FROM tickets GROUP BY priority",
    )).rows as any[];
    const ticketsByStatus = (await pool.query(
      "SELECT status, COUNT(*) AS c FROM tickets GROUP BY status",
    )).rows as any[];
    const ticketsByKind = (await pool.query(
      "SELECT kind, COUNT(*) AS c FROM tickets GROUP BY kind ORDER BY c DESC",
    )).rows as any[];
    // Repeated-problem bikes: more than one ticket ever logged against them.
    const repeatedProblemBikes = (await pool.query(`
      SELECT bike_id, COUNT(*) AS tickets,
             SUM(CASE WHEN status NOT IN ('resolved','closed','cancelled') THEN 1 ELSE 0 END) AS open
      FROM tickets
      GROUP BY bike_id
      HAVING COUNT(*) > 1
      ORDER BY tickets DESC
      LIMIT 12
    `)).rows as any[];

    // ---- Parking usage (proximity of ride starts in the period) ----
    const periodStarts = (await pool.query(
      "SELECT start_lat, start_lng FROM rides WHERE started_at >= $1 AND started_at <= $2",
      [from, to],
    )).rows as any[];
    const parkingUsage = (await this.listParkings()).map((p) => {
      let c = 0;
      for (const r of periodStarts) {
        const dx = r.start_lng - p.lng;
        const dy = r.start_lat - p.lat;
        if (Math.sqrt(dx * dx + dy * dy) < 30) c++;
      }
      return { id: p.id, name: p.name, capacity: p.capacity, occupied: p.occupied, rideStarts: c };
    }).sort((a, b) => b.rideStarts - a.rideStarts);

    return {
      range: { from, to },
      kpis: {
        ridesCount,
        activeRides,
        completedRides,
        revenue,
        avgDurationMin: avgDuration,
        avgCheck,
        newUsers,
        usersWithRides,
        openTickets,
      },
      byDay,
      topBikes,
      zeroRideBikes,
      usersSummary,
      service: {
        byPriority: ticketsByPriority,
        byStatus: ticketsByStatus,
        byKind: ticketsByKind,
        repeatedProblemBikes,
      },
      parkingUsage,
    };
  }
}

export const storage = new DatabaseStorage();

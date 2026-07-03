import {
  bikes, parkings, zones, rides, tickets, ticketComments, payments, wallet, mapObjects, users,
  otpRequests, phoneChangeRequests, paymentMethods, supportTickets, paymentOrders,
  TICKET_CLOSED_STATUSES,
} from "@shared/schema";
import type {
  Bike, Parking, ZoneRow, Ride, AdminRide, Ticket, TicketComment, TicketWithComments, Payment, Wallet,
  MapObject, InsertMapObject, User, OtpRequest, UserRole, UpdateProfileInput,
  PhoneChangeRequest, PaymentMethod, SupportTicket, PaymentOrder,
  AdminCreateBikeInput, AdminUpdateBikeInput, CreateTicketInput, UpdateTicketInput,
  AdminCreateParkingInput, AdminUpdateParkingInput,
} from "@shared/schema";
import { CONSENT_VERSION } from "@shared/schema";
import { randomUUID, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  PARKINGS, OPERATING_ZONE, SLOW_ZONES, FORBIDDEN_ZONES, MAP_W, MAP_H,
  TARIFFS, tariffPriceKopecks,
} from "@shared/geo";
import { computeOverage, finalRideCost } from "@shared/billing";
import { eq, desc, sql } from "drizzle-orm";
// db client + schema bootstrap + migrations + demo seed run on import of this module.
import { db, sqlite, sqliteDb } from "./db/bootstrap";
export { db, sqlite, sqliteDb };


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
  getUser(id: string): User | undefined;
  getUserByPhone(phone: string): User | undefined;
  updateProfile(id: string, patch: UpdateProfileInput): { user: User } | { error: string };
  // admin user management
  listUsers(): User[];
  setUserRole(id: string, role: UserRole): { user: User } | { error: string };
  setUserBlocked(id: string, blocked: boolean, reason?: string): { user: User } | { error: string };
  // OTP verification
  startOtp(input: { name: string; phone: string }):
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number };
  verifyOtp(input: { phone: string; code: string; consentIp?: string }): { user: User } | { error: string };
  // OTP delivery diagnostics (provider id/status persisted per phone)
  recordOtpSend(input: {
    phone: string;
    provider?: string;
    providerMessageId?: string;
    providerStatus?: string;
    providerError?: string;
  }): void;
  getLastOtpSend(phone: string): OtpRequest | undefined;
  updateOtpProviderStatus(input: {
    phone: string;
    providerStatus?: string;
    providerError?: string;
  }): void;
  // phone change (SMS OTP for an existing account)
  startPhoneChange(input: { userId: string; phone: string }):
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number };
  verifyPhoneChange(input: { userId: string; code: string }): { user: User } | { error: string };
  // payment methods (metadata only — no card data)
  listPaymentMethods(userId: string): PaymentMethod[];
  linkPaymentMethod(userId: string, type: "card" | "sbp"): PaymentMethod;
  unlinkPaymentMethod(userId: string, id: number): boolean;
  // T-Bank card binding (real acquiring metadata)
  createPendingCardMethod(input: { userId: string; customerKey: string; requestKey?: string }): PaymentMethod;
  createPendingBindPayment(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    amountKopecks: number;
  }): PaymentMethod;
  // SBP account binding (AddAccountQr): a pending sbp-type method keyed by the
  // RequestKey so the notification/state poll can attach the AccountToken.
  createPendingSbpBinding(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    requestKey?: string;
  }): PaymentMethod;
  getPaymentMethod(id: number): PaymentMethod | undefined;
  findPendingCardMethod(userId: string): PaymentMethod | undefined;
  findCardMethodByOrderId(orderId: string): PaymentMethod | undefined;
  findCardMethodByRequestKey(userId: string, requestKey: string): PaymentMethod | undefined;
  // Locate any T-Bank method (card or sbp) by RequestKey alone — used by the SBP
  // binding notification, which carries a RequestKey but no user id.
  findMethodByRequestKey(requestKey: string): PaymentMethod | undefined;
  // The rider's saved SBP account usable for a recurring charge (active + token).
  getActiveSavedSbp(userId: string, paymentMethodId?: number): PaymentMethod | undefined;
  updatePaymentMethod(id: number, patch: Partial<PaymentMethod>): PaymentMethod | undefined;
  // The rider's saved T-Bank card usable for a recurring charge (active + RebillId)
  getActiveSavedCard(userId: string, paymentMethodId?: number): PaymentMethod | undefined;
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
  }): PaymentOrder;
  getRidePaymentOrder(orderId: string): PaymentOrder | undefined;
  updateRidePaymentOrder(id: number, patch: Partial<PaymentOrder>): PaymentOrder | undefined;
  // support tickets (rider help requests)
  listSupportTickets(userId: string): SupportTicket[];
  createSupportTicket(input: { userId: string; subject: string; message: string }): SupportTicket;
  // bikes
  listBikes(opts?: { includeArchived?: boolean }): Bike[];
  getBike(id: string): Bike | undefined;
  updateBike(id: string, patch: Partial<Bike>): Bike | undefined;
  // bikes — admin CRUD (staff only)
  createBike(input: AdminCreateBikeInput): { bike: Bike } | { error: string };
  adminUpdateBike(id: string, patch: AdminUpdateBikeInput): { bike: Bike } | { error: string };
  archiveBike(id: string): { bike: Bike } | { error: string };
  deleteBike(id: string): { ok: true } | { error: string; archived?: Bike };
  // parkings
  listParkings(opts?: { includeInactive?: boolean; includeArchived?: boolean }): Parking[];
  getParking(id: string): Parking | undefined;
  createParking(input: AdminCreateParkingInput): { parking: Parking } | { error: string };
  updateParking(id: string, patch: AdminUpdateParkingInput): { parking: Parking } | { error: string };
  archiveParking(id: string): { parking: Parking } | { error: string };
  restoreParking(id: string): { parking: Parking } | { error: string };
  deleteParking(id: string): { ok: true } | { error: string; archived?: Parking };
  // zones
  listZones(): ZoneRow[];
  // rides
  startRide(input: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }): Ride | { error: string };
  appendRidePoint(rideId: number, x: number, y: number): Ride | undefined;
  endRide(rideId: number): Ride | undefined;
  getRide(rideId: number): Ride | undefined;
  getActiveRide(userId: string): Ride | undefined;
  listRides(opts?: { userId?: string; limit?: number }): Ride[];
  listAdminRides(opts?: { limit?: number }): AdminRide[];
  // payments / wallet
  getWallet(userId: string): Wallet;
  topUp(userId: string, amount: number): { wallet: Wallet; payment: Payment };
  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number): { wallet: Wallet; payment: Payment };
  listPayments(userId: string): Payment[];
  // service / maintenance tickets
  listTickets(): Ticket[];
  getTicket(id: number): TicketWithComments | undefined;
  createTicket(input: CreateTicketInput): TicketWithComments;
  updateTicket(id: number, patch: UpdateTicketInput, actor: string): TicketWithComments | undefined;
  addTicketComment(id: number, author: string, body: string): TicketWithComments | undefined;
  // map objects (operator-drawn routes/zones)
  listMapObjects(opts?: { activeOnly?: boolean }): MapObject[];
  createMapObject(input: InsertMapObject): MapObject;
  setMapObjectActive(id: number, active: boolean): MapObject | undefined;
  deleteMapObject(id: number): boolean;
  // analytics
  analytics(): any;
  // period-scoped analytics for the admin "Аналитика v1" page
  adminAnalytics(range: { from: number; to: number }): any;
}

export class DatabaseStorage implements IStorage {
  // Apply the env-driven admin override so callers always see the effective
  // role without each one re-checking ADMIN_PHONE_NUMBERS.
  private withResolvedRole(user: User | undefined): User | undefined {
    if (!user) return user;
    return { ...user, role: resolveRole(user) };
  }

  getUser(id: string) {
    const u = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    return this.withResolvedRole(u);
  }

  getUserByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    const u = db.select().from(users).where(eq(users.phone, normalized)).get() as User | undefined;
    return this.withResolvedRole(u);
  }

  // Self-service profile update for the current user. Only name/email are
  // mutable here; phone changes must go through SMS OTP (not this endpoint).
  updateProfile(id: string, patch: UpdateProfileInput) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };

    const set: Partial<User> = { updatedAt: Date.now() };
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.email !== undefined) {
      const email = patch.email.trim();
      set.email = email.length > 0 ? email : null;
    }
    db.update(users).set(set as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  // ---------- Admin user management ----------
  // List every registered user, newest first, with effective roles applied so
  // the admin table shows the same role the rest of the app enforces (the
  // ADMIN_PHONE_NUMBERS override can make a stored "rider" effectively admin).
  listUsers() {
    const rows = db.select().from(users).orderBy(desc(users.createdAt)).all() as User[];
    return rows.map((u) => this.withResolvedRole(u)!);
  }

  setUserRole(id: string, role: UserRole) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };
    db.update(users).set({ role, updatedAt: Date.now() } as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  setUserBlocked(id: string, blocked: boolean, reason?: string) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };
    const set: Partial<User> = {
      blockedAt: blocked ? Date.now() : null,
      blockedReason: blocked ? (reason?.trim() || null) : null,
      updatedAt: Date.now(),
    };
    db.update(users).set(set as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  // ---------- OTP verification ----------
  // Step 1: create/refresh a pending code for this phone and hand the plaintext
  // back to the caller so it can be dispatched via SMS. The code itself is only
  // stored as an HMAC. Enforces a per-phone resend lock.
  startOtp({ name, phone }: { name: string; phone: string }) {
    const cleanName = name.trim();
    const cleanPhone = normalizePhone(phone);
    const digits = cleanPhone.replace(/\D/g, "");
    if (cleanName.length < 2) return { error: "Имя должно содержать минимум 2 символа" };
    if (digits.length < 10) return { error: "Введите корректный номер телефона" };

    const now = Date.now();
    const existing = db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).get() as OtpRequest | undefined;

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

    db.insert(otpRequests)
      .values({ phone: cleanPhone, name: cleanName, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: otpRequests.phone,
        set: { name: cleanName, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      })
      .run();

    return { ok: true as const, phone: cleanPhone, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  // Step 2: verify a submitted code. On success the rider is created (or reused
  // if the phone already registered) and the request row is consumed.
  verifyOtp({ phone, code, consentIp }: { phone: string; code: string; consentIp?: string }) {
    const cleanPhone = normalizePhone(phone);
    const req = db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).get() as OtpRequest | undefined;

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
      db.update(otpRequests).set({ attempts }).where(eq(otpRequests.phone, cleanPhone)).run();
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Correct code — consume the request so it can't be reused.
    db.update(otpRequests).set({ consumed: true }).where(eq(otpRequests.phone, cleanPhone)).run();

    // Consent was accepted at OTP start (the API requires consent: true before
    // a code is sent), so record the consent metadata on verify when the rider
    // row is created/refreshed. The verified phone IS the proof of consent.
    const now = Date.now();
    const role: UserRole = isAdminPhone(cleanPhone) ? "admin" : "rider";

    // Reuse an existing rider for this phone (keeps rides/wallet) or create one.
    const existing = db.select().from(users).where(eq(users.phone, cleanPhone)).get() as
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
      db.update(users).set(set as any).where(eq(users.id, existing.id)).run();
      return { user: this.getUser(existing.id)! };
    }
    db.insert(users).values({
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
    } as any).run();
    return { user: this.getUserByPhone(cleanPhone)! };
  }

  // ---------- OTP delivery diagnostics ----------
  // Persist the provider id/status returned when an OTP SMS was accepted (or the
  // safe error when it was not). Keyed by phone, matching the single pending OTP
  // row. A no-op if the row was already consumed/removed by a concurrent verify.
  recordOtpSend({ phone, provider, providerMessageId, providerStatus, providerError }: {
    phone: string;
    provider?: string;
    providerMessageId?: string;
    providerStatus?: string;
    providerError?: string;
  }) {
    const cleanPhone = normalizePhone(phone);
    db.update(otpRequests)
      .set({
        provider: provider ?? null,
        providerMessageId: providerMessageId ?? null,
        providerStatus: providerStatus ?? null,
        providerError: providerError ?? null,
        providerCheckedAt: Date.now(),
      })
      .where(eq(otpRequests.phone, cleanPhone))
      .run();
  }

  // Read the latest OTP request row for a phone (includes provider diagnostics).
  getLastOtpSend(phone: string): OtpRequest | undefined {
    const cleanPhone = normalizePhone(phone);
    return db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).get() as OtpRequest | undefined;
  }

  // Update only the provider delivery status/error after a status refresh. Does
  // not touch the OTP lifecycle fields (code/expiry/attempts/consumed).
  updateOtpProviderStatus({ phone, providerStatus, providerError }: {
    phone: string;
    providerStatus?: string;
    providerError?: string;
  }) {
    const cleanPhone = normalizePhone(phone);
    db.update(otpRequests)
      .set({
        providerStatus: providerStatus ?? null,
        providerError: providerError ?? null,
        providerCheckedAt: Date.now(),
      })
      .where(eq(otpRequests.phone, cleanPhone))
      .run();
  }

  // ---------- Phone change (SMS OTP, existing account) ----------
  // Step 1: a logged-in rider requests a code sent to a NEW number. The pending
  // request is keyed by the user id and stores the target phone; the code is
  // stored only as an HMAC. Enforces the same per-request resend lock as
  // registration and refuses a number already used by another account.
  startPhoneChange({ userId, phone }: { userId: string; phone: string }) {
    const user = db.select().from(users).where(eq(users.id, userId)).get() as User | undefined;
    if (!user) return { error: "Пользователь не найден" };

    const newPhone = normalizePhone(phone);
    const digits = newPhone.replace(/\D/g, "");
    if (digits.length < 10) return { error: "Введите корректный номер телефона" };
    if (newPhone === user.phone) return { error: "Это уже ваш текущий номер" };

    // Don't allow merging into another account's number.
    const taken = db.select().from(users).where(eq(users.phone, newPhone)).get() as User | undefined;
    if (taken && taken.id !== userId) {
      return { error: "Этот номер уже используется другим аккаунтом" };
    }

    const now = Date.now();
    const existing = db.select().from(phoneChangeRequests)
      .where(eq(phoneChangeRequests.userId, userId)).get() as PhoneChangeRequest | undefined;
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
    db.insert(phoneChangeRequests)
      .values({ userId, newPhone, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: phoneChangeRequests.userId,
        set: { newPhone, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      })
      .run();

    return { ok: true as const, phone: newPhone, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  // Step 2: verify the code sent to the new number and, on success, update the
  // user's phone. The request row is consumed so the code can't be reused.
  verifyPhoneChange({ userId, code }: { userId: string; code: string }) {
    const req = db.select().from(phoneChangeRequests)
      .where(eq(phoneChangeRequests.userId, userId)).get() as PhoneChangeRequest | undefined;
    if (!req || req.consumed) return { error: "Запросите код подтверждения заново" };
    if (Date.now() > req.expiresAt) return { error: "Срок действия кода истёк. Запросите новый код" };
    if (req.attempts >= OTP_MAX_ATTEMPTS) return { error: "Слишком много попыток. Запросите новый код" };

    const provided = hashOtp(req.newPhone, code.trim());
    if (!safeEqualHex(provided, req.codeHash)) {
      const attempts = req.attempts + 1;
      db.update(phoneChangeRequests).set({ attempts }).where(eq(phoneChangeRequests.userId, userId)).run();
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Re-check the number is still free (another account could have claimed it
    // between request and verify), then apply the change.
    const taken = db.select().from(users).where(eq(users.phone, req.newPhone)).get() as User | undefined;
    if (taken && taken.id !== userId) {
      return { error: "Этот номер уже используется другим аккаунтом" };
    }

    db.update(phoneChangeRequests).set({ consumed: true }).where(eq(phoneChangeRequests.userId, userId)).run();
    db.update(users).set({ phone: req.newPhone, updatedAt: Date.now() } as any).where(eq(users.id, userId)).run();
    return { user: this.getUser(userId)! };
  }

  // ---------- Payment methods (MVP metadata only) ----------
  listPaymentMethods(userId: string) {
    return db.select().from(paymentMethods)
      .where(eq(paymentMethods.userId, userId))
      .orderBy(desc(paymentMethods.createdAt))
      .all() as PaymentMethod[];
  }

  // Link a method. Label/status are derived server-side so no card data can be
  // injected via the client. A masked test pan is used for "card" — never a
  // real number — and a fixed label for SBP.
  linkPaymentMethod(userId: string, type: "card" | "sbp") {
    const label = type === "card" ? "•••• 4242" : "СБП";
    return db.insert(paymentMethods).values({
      userId, type, label, status: "linked", createdAt: Date.now(),
    }).returning().get() as PaymentMethod;
  }

  unlinkPaymentMethod(userId: string, id: number) {
    const res = db.delete(paymentMethods)
      .where(sql`${paymentMethods.id} = ${id} AND ${paymentMethods.userId} = ${userId}`)
      .run();
    return res.changes > 0;
  }

  // ---------- T-Bank card binding (real acquiring metadata) ----------
  // Create a pending card method when a binding flow starts. The card is not
  // usable until the notification confirms it (status -> active) and fills in
  // CardId/RebillId. No card data is ever stored here.
  createPendingCardMethod(input: { userId: string; customerKey: string; requestKey?: string }) {
    const now = Date.now();
    return db.insert(paymentMethods).values({
      userId: input.userId,
      type: "card",
      label: "Карта (привязывается…)",
      status: "pending",
      provider: "tbank",
      customerKey: input.customerKey,
      requestKey: input.requestKey ?? null,
      createdAt: now,
      updatedAt: now,
    } as any).returning().get() as PaymentMethod;
  }

  // Create a pending card method backed by an Init+Recurrent verification
  // payment (the primary binding path). Stores our OrderId + amount so the
  // notification webhook can correlate the payment back to this row. The card is
  // not usable until the payment is CONFIRMED/AUTHORIZED with a RebillId. No card
  // data is ever stored here — the PAN/CVC live only on T-Bank's hosted form.
  createPendingBindPayment(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    amountKopecks: number;
  }) {
    const now = Date.now();
    return db.insert(paymentMethods).values({
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
    } as any).returning().get() as PaymentMethod;
  }

  // Create a pending SBP account binding (AddAccountQr). The account is not
  // usable until the payer authorises it in their bank and T-Bank returns an
  // AccountToken (via notification or GetAddAccountQrState). We store the
  // RequestKey + OrderId so either path can correlate back to this row. No
  // account/card data is ever stored — only the opaque provider identifiers.
  createPendingSbpBinding(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    requestKey?: string;
  }) {
    const now = Date.now();
    return db.insert(paymentMethods).values({
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
    } as any).returning().get() as PaymentMethod;
  }

  getPaymentMethod(id: number) {
    return db.select().from(paymentMethods).where(eq(paymentMethods.id, id)).get() as
      | PaymentMethod
      | undefined;
  }

  // The most recent pending T-Bank card binding for a user. Used by the
  // notification handler to attach the confirmed card to the binding the rider
  // just started.
  findPendingCardMethod(userId: string) {
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'pending'`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  // Locate a T-Bank card-binding method by the Init OrderId echoed back in the
  // payment notification. This is how the webhook correlates a verification
  // payment to the pending method (the Init flow has no RequestKey).
  findCardMethodByOrderId(orderId: string) {
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.provider} = 'tbank' AND ${paymentMethods.orderId} = ${orderId}`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  // Locate a user's T-Bank card method by its AddCard RequestKey. Used to
  // resolve the method a rider was redirected back from (the Success/Fail URL
  // carries the RequestKey) so we can refresh exactly that binding.
  findCardMethodByRequestKey(userId: string, requestKey: string) {
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.requestKey} = ${requestKey}`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  // Locate any T-Bank method by RequestKey alone (no user scope). The SBP
  // binding notification carries a RequestKey but not our user id, so this is
  // how the webhook attaches the AccountToken to the right pending row.
  findMethodByRequestKey(requestKey: string) {
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.provider} = 'tbank' AND ${paymentMethods.requestKey} = ${requestKey}`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  // Resolve the rider's saved SBP account eligible for a recurring charge: an
  // active sbp-type method with an AccountToken. Mirrors getActiveSavedCard.
  getActiveSavedSbp(userId: string, paymentMethodId?: number) {
    if (paymentMethodId != null) {
      const m = this.getPaymentMethod(paymentMethodId);
      if (!m || m.userId !== userId) return undefined;
      if (m.provider !== "tbank" || m.status !== "active" || !m.accountToken) return undefined;
      return m;
    }
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'active' AND ${paymentMethods.accountToken} IS NOT NULL AND ${paymentMethods.accountToken} != ''`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  updatePaymentMethod(id: number, patch: Partial<PaymentMethod>) {
    const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
    delete set.id;
    db.update(paymentMethods).set(set as any).where(eq(paymentMethods.id, id)).run();
    return this.getPaymentMethod(id);
  }

  // ---------- T-Bank ordinary ride payment orders ----------
  // Create a pending ride payment order when the rider starts the pay-then-ride
  // flow. The ride is NOT started until the payment is confirmed by the
  // notification webhook (status -> paid, ride_id filled). No card data is ever
  // stored here — the PAN/CVC live only on T-Bank's hosted form.
  createRidePaymentOrder(input: {
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
    return db.insert(paymentOrders).values({
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
    } as any).returning().get() as PaymentOrder;
  }

  // Resolve the rider's saved T-Bank card eligible for a recurring charge: an
  // active card-type method with a RebillId. When paymentMethodId is given it
  // must belong to the rider and be active with a RebillId; otherwise the most
  // recent qualifying card is returned. Returns undefined when no usable saved
  // card exists (the caller then falls back to the hosted payment flow).
  getActiveSavedCard(userId: string, paymentMethodId?: number) {
    if (paymentMethodId != null) {
      const m = this.getPaymentMethod(paymentMethodId);
      if (!m || m.userId !== userId) return undefined;
      if (m.provider !== "tbank" || m.status !== "active" || !m.rebillId) return undefined;
      return m;
    }
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'active' AND ${paymentMethods.rebillId} IS NOT NULL AND ${paymentMethods.rebillId} != ''`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  getRidePaymentOrder(orderId: string) {
    return db.select().from(paymentOrders)
      .where(eq(paymentOrders.orderId, orderId))
      .get() as PaymentOrder | undefined;
  }

  updateRidePaymentOrder(id: number, patch: Partial<PaymentOrder>) {
    const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
    delete set.id;
    db.update(paymentOrders).set(set as any).where(eq(paymentOrders.id, id)).run();
    return db.select().from(paymentOrders).where(eq(paymentOrders.id, id)).get() as
      | PaymentOrder
      | undefined;
  }

  // ---------- Support tickets ----------
  listSupportTickets(userId: string) {
    return db.select().from(supportTickets)
      .where(eq(supportTickets.userId, userId))
      .orderBy(desc(supportTickets.createdAt))
      .all() as SupportTicket[];
  }

  createSupportTicket({ userId, subject, message }: { userId: string; subject: string; message: string }) {
    return db.insert(supportTickets).values({
      userId, subject: subject.trim(), message: message.trim(), status: "open", createdAt: Date.now(),
    }).returning().get() as SupportTicket;
  }

  // Public list excludes archived (retired) bikes so they never appear on the
  // map or in rental selection. Admin callers pass includeArchived to see all.
  listBikes(opts?: { includeArchived?: boolean }) {
    const rows = db.select().from(bikes).all() as Bike[];
    if (opts?.includeArchived) return rows;
    return rows.filter((b) => b.status !== "archived");
  }
  getBike(id: string) { return db.select().from(bikes).where(eq(bikes.id, id)).get() as Bike | undefined; }
  updateBike(id: string, patch: Partial<Bike>) {
    db.update(bikes).set(patch as any).where(eq(bikes.id, id)).run();
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
  createBike(input: AdminCreateBikeInput) {
    const id = input.id.trim().toUpperCase();
    if (this.getBike(id)) return { error: "Велосипед с таким кодом уже существует" };

    let lat = MAP_H / 2;
    let lng = MAP_W / 2;
    const parkingId = this.optStr(input.parkingId);
    if (parkingId) {
      const p = db.select().from(parkings).where(eq(parkings.id, parkingId)).get() as Parking | undefined;
      if (p) { lat = p.lat; lng = p.lng; }
    }

    const now = Date.now();
    db.insert(bikes).values({
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
    } as any).run();
    return { bike: this.getBike(id)! };
  }

  adminUpdateBike(id: string, patch: AdminUpdateBikeInput) {
    const existing = this.getBike(id);
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
    db.update(bikes).set(set as any).where(eq(bikes.id, id)).run();
    return { bike: this.getBike(id)! };
  }

  // Soft delete: mark a bike archived so it drops out of the public list and
  // rental selection while keeping its ride history intact.
  archiveBike(id: string) {
    const existing = this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };
    if (existing.status === "rented") return { error: "Нельзя архивировать велосипед во время активной аренды" };
    db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id)).run();
    return { bike: this.getBike(id)! };
  }

  // Hard delete: only allowed when the bike has no ride history. Otherwise we
  // refuse and archive instead, so analytics/ride records never dangle.
  deleteBike(id: string) {
    const existing = this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };
    if (existing.status === "rented") return { error: "Нельзя удалить велосипед во время активной аренды" };
    const rideCount = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides WHERE bike_id = ?").get(id) as { c: number }).c;
    if (rideCount > 0) {
      db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id)).run();
      return { error: "У велосипеда есть история поездок — он переведён в архив", archived: this.getBike(id)! };
    }
    db.delete(bikes).where(eq(bikes.id, id)).run();
    return { ok: true as const };
  }
  // ---------- Parkings: read + admin CRUD ----------
  // Public callers get active, non-archived points only. The admin page passes
  // includeInactive/includeArchived to see the full set.
  listParkings(opts?: { includeInactive?: boolean; includeArchived?: boolean }) {
    let rows = db.select().from(parkings).all() as Parking[];
    if (!opts?.includeArchived) rows = rows.filter((p) => !p.archivedAt);
    if (!opts?.includeInactive) rows = rows.filter((p) => p.status === "active");
    return rows;
  }
  getParking(id: string) {
    return db.select().from(parkings).where(eq(parkings.id, id)).get() as Parking | undefined;
  }

  // Generate the next free P-NN id when the operator doesn't supply one.
  private nextParkingId(): string {
    const ids = (db.select({ id: parkings.id }).from(parkings).all() as { id: string }[]).map((r) => r.id);
    let n = 1;
    while (ids.includes(`P-${String(n).padStart(2, "0")}`)) n++;
    return `P-${String(n).padStart(2, "0")}`;
  }

  createParking(input: AdminCreateParkingInput) {
    const id = (input.id && input.id.trim().length > 0 ? input.id.trim().toUpperCase() : this.nextParkingId());
    if (this.getParking(id)) return { error: "Парковка с таким кодом уже существует" };
    const now = Date.now();
    const occupied = Math.min(input.occupied, input.capacity);
    db.insert(parkings).values({
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
    } as any).run();
    return { parking: this.getParking(id)! };
  }

  updateParking(id: string, patch: AdminUpdateParkingInput) {
    const existing = this.getParking(id);
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
    db.update(parkings).set(set as any).where(eq(parkings.id, id)).run();
    return { parking: this.getParking(id)! };
  }

  // Soft delete: stamp archivedAt so the point drops out of every list while
  // staying referenceable from bikes/history that point at its id.
  archiveParking(id: string) {
    const existing = this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    db.update(parkings).set({ archivedAt: Date.now(), updatedAt: Date.now() } as any).where(eq(parkings.id, id)).run();
    return { parking: this.getParking(id)! };
  }

  // Undo a soft delete: clear archivedAt and force status to inactive so the
  // point returns muted on the admin maps but never re-appears on the public
  // map until an operator explicitly re-activates it.
  restoreParking(id: string) {
    const existing = this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    if (!existing.archivedAt) return { error: "Парковка не в архиве" };
    db.update(parkings).set({ archivedAt: null, status: "inactive", updatedAt: Date.now() } as any).where(eq(parkings.id, id)).run();
    return { parking: this.getParking(id)! };
  }

  // Hard delete: only when no bike references this parking. Otherwise archive so
  // bike.parkingId never dangles.
  deleteParking(id: string) {
    const existing = this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    const refCount = (sqlite.prepare("SELECT COUNT(*) AS c FROM bikes WHERE parking_id = ?").get(id) as { c: number }).c;
    if (refCount > 0) {
      db.update(parkings).set({ archivedAt: Date.now(), updatedAt: Date.now() } as any).where(eq(parkings.id, id)).run();
      return { error: "К парковке привязаны велосипеды — она переведена в архив", archived: this.getParking(id)! };
    }
    db.delete(parkings).where(eq(parkings.id, id)).run();
    return { ok: true as const };
  }

  listZones() { return db.select().from(zones).all() as ZoneRow[]; }

  // ---- ride GPS points (append-only, avoids O(N^2) track rewrites) ----
  // Live points go to their own ride_points table so each appended point is a
  // single INSERT instead of parsing + re-stringifying the whole track JSON.
  // rides.track stays the canonical stored track, finalised once in endRide.
  private static _insertPoint = sqlite.prepare(
    "INSERT INTO ride_points (ride_id, x, y, t) VALUES (?, ?, ?, ?)",
  );
  private static _selectPoints = sqlite.prepare(
    "SELECT x, y, t FROM ride_points WHERE ride_id = ? ORDER BY id",
  );
  private static _selectLastPoint = sqlite.prepare(
    "SELECT x, y, t FROM ride_points WHERE ride_id = ? ORDER BY id DESC LIMIT 1",
  );

  private insertRidePoint(rideId: number, x: number, y: number, t: number) {
    DatabaseStorage._insertPoint.run(rideId, x, y, t);
  }

  private loadRidePoints(rideId: number): [number, number, number][] {
    const rows = DatabaseStorage._selectPoints.all(rideId) as { x: number; y: number; t: number }[];
    return rows.map((p) => [p.x, p.y, p.t]);
  }

  // Return the ride with its live track hydrated from ride_points. Only active
  // rides read from ride_points (the authoritative live track); a finished
  // ride already has its track flushed into rides.track by endRide, so we leave
  // it untouched even though its point rows may linger.
  private hydrateTrack(ride: Ride | undefined): Ride | undefined {
    if (!ride) return ride;
    if (ride.status !== "active") return ride;
    const pts = this.loadRidePoints(ride.id);
    if (pts.length === 0) return ride;
    return { ...ride, track: JSON.stringify(pts) };
  }

  startRide({ bikeId, userId, tariff, prepaid }: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }) {
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
    return db.transaction((tx) => {
      const bike = tx.select().from(bikes).where(eq(bikes.id, bikeId)).get() as Bike | undefined;
      if (!bike) return { error: "Велосипед не найден" };
      if (bike.status !== "available" && bike.status !== "reserved") {
        return { error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` };
      }
      if (bike.battery < 18) return { error: "Низкий заряд замка, выберите другой велосипед" };
      const active = tx.select().from(rides)
        .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
        .get() as Ride | undefined;
      if (active) return { error: "У вас уже есть активная поездка" };

      // Internal (non-prepaid) flow: debit the tariff price from the wallet up
      // front, inside the same transaction so a failure rolls the ride back.
      if (!prepaid && costKopecks > 0) {
        let w = tx.select().from(wallet).where(eq(wallet.userId, userId)).get() as Wallet | undefined;
        if (!w) {
          tx.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any).run();
          w = { userId, balance: 0 } as Wallet;
        }
        if (w.balance < costKopecks) {
          return { error: "Недостаточно средств на балансе" };
        }
        tx.update(wallet).set({ balance: w.balance - costKopecks }).where(eq(wallet.userId, userId)).run();
        tx.insert(payments).values({
          userId, amount: -costKopecks, kind: "ride_charge",
          description: `Аренда ${bikeId} • ${tariffDef?.name ?? tariff}`, createdAt: Date.now(),
        }).run();
      }

      const startedAt = Date.now();
      const track: [number, number, number][] = [[bike.lng, bike.lat, startedAt]];
      const row = tx.insert(rides).values({
        bikeId, userId, startedAt,
        startLat: bike.lat, startLng: bike.lng,
        track: JSON.stringify(track), distanceM: 0, cost: costKopecks, tariff, status: "active",
      }).returning().get() as Ride;
      tx.update(bikes).set({ status: "rented", updatedAt: Date.now() } as any)
        .where(eq(bikes.id, bikeId)).run();
      // Seed the append-only points table with the start point so the live
      // track (hydrated from ride_points) is never empty for a fresh ride.
      tx.run(sql`INSERT INTO ride_points (ride_id, x, y, t) VALUES (${row.id}, ${bike.lng}, ${bike.lat}, ${startedAt})`);
      return row;
    });
  }

  appendRidePoint(rideId: number, x: number, y: number) {
    const r = db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride | undefined;
    if (!r || r.status !== "active") return undefined;
    // Distance delta is computed from the LAST stored point only — a single
    // indexed row read, not a parse of the whole track. Then we append one row
    // instead of rewriting the entire track JSON (was O(N^2) per ride).
    const last = DatabaseStorage._selectLastPoint.get(rideId) as
      | { x: number; y: number; t: number }
      | undefined;
    const px = last ? last.x : r.startLng;
    const py = last ? last.y : r.startLat;
    const dx = x - px, dy = y - py;
    const dMap = Math.sqrt(dx * dx + dy * dy);
    // 1 map unit ≈ 30 metres (≈30km coastal span across 1000 units, demo scale)
    const addedMeters = dMap * 30;
    const newDistance = r.distanceM + addedMeters;
    this.insertRidePoint(rideId, x, y, Date.now());
    // Hourly prepaid model: cost is fixed at start (tariff price) and only
    // changes on overage in endRide. Live points update the distance only —
    // never the price. rides.track is finalised once in endRide.
    db.update(rides).set({ distanceM: newDistance }).where(eq(rides.id, rideId)).run();
    db.update(bikes).set({ lat: y, lng: x, lastSeen: Date.now(), idleHours: 0 } as any)
      .where(eq(bikes.id, r.bikeId)).run();
    return this.hydrateTrack(
      db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride,
    );
  }

  endRide(rideId: number) {
    // Atomic: completing a ride touches four tables (ride, bike, wallet,
    // payment ledger). Doing them as separate statements risks a partial state
    // if the process dies mid-way — e.g. wallet debited but ride still active,
    // or bike freed without a charge recorded. One transaction keeps them
    // consistent: either the whole settlement lands or none of it does.
    return db.transaction((tx) => {
      const r = tx.select().from(rides).where(eq(rides.id, rideId)).get() as Ride | undefined;
      if (!r || r.status !== "active") return undefined;
      // Flush the append-only points into the canonical rides.track ONCE, at
      // completion. Fall back to the legacy in-row track for rides that started
      // before the ride_points migration and never got any point rows.
      const pts: [number, number, number][] =
        this.loadRidePoints(rideId) ?? [];
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

      tx.update(rides).set({
        endedAt, status: "completed", cost: finalCost,
        endLat: last[1], endLng: last[0],
        track: JSON.stringify(track),
      }).where(eq(rides.id, rideId)).run();
      tx.update(bikes).set({ status: "available", lat: last[1], lng: last[0], lastSeen: endedAt, idleHours: 0 } as any)
        .where(eq(bikes.id, r.bikeId)).run();

      // Only the overage is charged at end — the base tariff was already paid at
      // start (wallet debit or T-Bank). Debit the wallet for the extra hours,
      // inside the same tx so it rolls back with everything else on failure.
      if (overageKopecks > 0) {
        let w = tx.select().from(wallet).where(eq(wallet.userId, r.userId)).get() as Wallet | undefined;
        if (!w) {
          tx.insert(wallet).values({ userId: r.userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any).run();
          w = { userId: r.userId, balance: 0 } as Wallet;
        }
        tx.update(wallet).set({ balance: w.balance - overageKopecks }).where(eq(wallet.userId, r.userId)).run();
        tx.insert(payments).values({
          userId: r.userId, amount: -overageKopecks, kind: "ride_charge",
          description: `Продление аренды ${r.bikeId} • +${extraHours} ч`, createdAt: endedAt,
        }).run();
      }
      return tx.select().from(rides).where(eq(rides.id, rideId)).get() as Ride;
    });
  }

  getRide(rideId: number) {
    return this.hydrateTrack(
      db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride | undefined,
    );
  }

  getActiveRide(userId: string) {
    return this.hydrateTrack(
      db.select().from(rides)
        .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
        .get() as Ride | undefined,
    );
  }

  listRides(opts?: { userId?: string; limit?: number }) {
    const limit = opts?.limit ?? 50;
    const rows = opts?.userId
      ? (db.select().from(rides)
          .where(eq(rides.userId, opts.userId))
          .orderBy(desc(rides.startedAt))
          .limit(limit)
          .all() as Ride[])
      : (db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit).all() as Ride[]);
    return rows.map((r) => this.hydrateTrack(r)!) as Ride[];
  }

  // Rides for the operator panel, newest first, joined to rider identity so the
  // admin table can show a name/phone instead of a raw user id. Riders are
  // looked up in a single batch; unknown/demo ids resolve to null so the UI can
  // fall back to the id.
  listAdminRides(opts?: { limit?: number }) {
    const limit = opts?.limit ?? 200;
    const rows = db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit).all() as Ride[];
    const all = db.select().from(users).all() as User[];
    const byId = new Map(all.map((u) => [u.id, u]));
    return rows.map((r) => {
      const hydrated = this.hydrateTrack(r)!;
      const u = byId.get(hydrated.userId);
      return { ...hydrated, userName: u?.name ?? null, userPhone: u?.phone ?? null } as AdminRide;
    });
  }

  getWallet(userId: string) {
    let w = db.select().from(wallet).where(eq(wallet.userId, userId)).get() as Wallet | undefined;
    if (!w) {
      db.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any).run();
      w = db.select().from(wallet).where(eq(wallet.userId, userId)).get() as Wallet;
    }
    return w;
  }

  topUp(userId: string, amount: number) {
    const w = this.getWallet(userId);
    const newBal = w.balance + amount;
    db.update(wallet).set({ balance: newBal }).where(eq(wallet.userId, userId)).run();
    const pay = db.insert(payments).values({
      userId, amount, kind: "topup",
      description: `Пополнение баланса карты •• 4242`, createdAt: Date.now(),
    }).returning().get() as Payment;
    return { wallet: this.getWallet(userId), payment: pay };
  }

  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number) {
    const w = this.getWallet(userId);
    const newBal = w.balance - price;
    const expires = Date.now() + durationMs;
    db.update(wallet).set({ balance: newBal, activeTariff: tariff, tariffExpiresAt: expires } as any)
      .where(eq(wallet.userId, userId)).run();
    const pay = db.insert(payments).values({
      userId, amount: -price, kind: "tariff_purchase",
      description: `Подключён тариф «${tariff}»`, createdAt: Date.now(),
    }).returning().get() as Payment;
    return { wallet: this.getWallet(userId), payment: pay };
  }

  listPayments(userId: string) {
    return db.select().from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt))
      .all() as Payment[];
  }

  listTickets() { return db.select().from(tickets).orderBy(desc(tickets.createdAt)).all() as Ticket[]; }

  getTicket(id: number): TicketWithComments | undefined {
    const t = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!t) return undefined;
    const comments = db.select().from(ticketComments)
      .where(eq(ticketComments.ticketId, id))
      .orderBy(ticketComments.createdAt)
      .all() as TicketComment[];
    return { ...t, comments };
  }

  private addEvent(ticketId: number, author: string, body: string, kind: "comment" | "event") {
    db.insert(ticketComments).values({
      ticketId, author, body, kind, createdAt: Date.now(),
    }).run();
  }

  createTicket(input: CreateTicketInput): TicketWithComments {
    const now = Date.now();
    const title = (input.title ?? "").trim();
    const assignee = (input.assignee ?? "").trim();
    const row = db.insert(tickets).values({
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
    }).returning().get() as Ticket;
    this.addEvent(row.id, "Система", "Заявка создана", "event");

    // High/critical tickets pull a rentable bike out of rotation into
    // maintenance so it can't be rented while the issue is open. We never touch
    // a bike that's mid-ride (rented) or already out of service.
    if ((input.priority === "high" || input.priority === "critical")) {
      const bike = this.getBike(input.bikeId);
      if (bike && (bike.status === "available" || bike.status === "reserved")) {
        this.updateBike(bike.id, { status: "maintenance" });
        this.addEvent(row.id, "Система", `Велосипед ${bike.id} переведён в обслуживание`, "event");
      }
    }
    return this.getTicket(row.id)!;
  }

  updateTicket(id: number, patch: UpdateTicketInput, actor: string): TicketWithComments | undefined {
    const existing = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!existing) return undefined;
    const now = Date.now();
    const set: Partial<Ticket> = { updatedAt: now };

    if (patch.priority !== undefined && patch.priority !== existing.priority) {
      set.priority = patch.priority;
      this.addEvent(id, actor, `Приоритет: ${existing.priority} → ${patch.priority}`, "event");
    }
    if (patch.assignee !== undefined) {
      const next = patch.assignee.trim() || null;
      if (next !== (existing.assignee ?? null)) {
        set.assignee = next;
        this.addEvent(id, actor, next ? `Назначено: ${next}` : "Исполнитель снят", "event");
      }
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      set.status = patch.status;
      const becameClosed = TICKET_CLOSED_STATUSES.includes(patch.status);
      set.closedAt = becameClosed ? now : null;
      this.addEvent(id, actor, `Статус: ${existing.status} → ${patch.status}`, "event");
    }

    db.update(tickets).set(set as any).where(eq(tickets.id, id)).run();

    // Optional action when closing: return the bike to the rental pool if it's
    // currently in maintenance because of this issue.
    if (patch.returnBikeToAvailable) {
      const bike = this.getBike(existing.bikeId);
      if (bike && bike.status === "maintenance") {
        this.updateBike(bike.id, { status: "available" });
        this.addEvent(id, actor, `Велосипед ${bike.id} возвращён в доступные`, "event");
      }
    }
    return this.getTicket(id);
  }

  addTicketComment(id: number, author: string, body: string): TicketWithComments | undefined {
    const existing = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!existing) return undefined;
    this.addEvent(id, author, body, "comment");
    db.update(tickets).set({ updatedAt: Date.now() }).where(eq(tickets.id, id)).run();
    return this.getTicket(id);
  }

  listMapObjects(opts?: { activeOnly?: boolean }) {
    const rows = db.select().from(mapObjects).orderBy(desc(mapObjects.createdAt)).all() as MapObject[];
    return opts?.activeOnly ? rows.filter((o) => o.active) : rows;
  }

  createMapObject(input: InsertMapObject) {
    return db.insert(mapObjects).values({
      name: input.name,
      type: input.type,
      kind: input.kind,
      color: input.color,
      points: JSON.stringify(input.points),
      active: input.active,
      createdAt: Date.now(),
    }).returning().get() as MapObject;
  }

  setMapObjectActive(id: number, active: boolean) {
    db.update(mapObjects).set({ active } as any).where(eq(mapObjects.id, id)).run();
    return db.select().from(mapObjects).where(eq(mapObjects.id, id)).get() as MapObject | undefined;
  }

  deleteMapObject(id: number) {
    const res = db.delete(mapObjects).where(eq(mapObjects.id, id)).run();
    return res.changes > 0;
  }

  analytics() {
    const total = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides").get() as any).c;
    const completed = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides WHERE status='completed'").get() as any).c;
    const revenue = (sqlite.prepare("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed'").get() as any).s;
    const avgDuration = (sqlite.prepare("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed'").get() as any).a;
    const avgDistance = (sqlite.prepare("SELECT COALESCE(AVG(distance_m),0) AS a FROM rides WHERE status='completed'").get() as any).a;

    const byDay = sqlite.prepare(`
      SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
             COUNT(*) AS rides_count,
             COALESCE(SUM(cost),0) AS revenue
      FROM rides
      GROUP BY day
      ORDER BY day DESC
      LIMIT 14
    `).all().reverse();

    // popular parkings — proximity of ride start
    const allParkings = this.listParkings();
    const allRides = sqlite.prepare("SELECT start_lat, start_lng FROM rides").all() as any[];
    const parkingCounts = allParkings.map(p => {
      let c = 0;
      for (const r of allRides) {
        const dx = r.start_lng - p.lng;
        const dy = r.start_lat - p.lat;
        if (Math.sqrt(dx*dx+dy*dy) < 30) c++;
      }
      return { ...p, rideStarts: c };
    }).sort((a, b) => b.rideStarts - a.rideStarts);

    const utilisation = sqlite.prepare(`
      SELECT bike_id, COUNT(*) AS rides
      FROM rides
      GROUP BY bike_id
      ORDER BY rides DESC
      LIMIT 8
    `).all();

    const problemBikes = sqlite.prepare(`
      SELECT * FROM bikes
      WHERE flagged = 1 OR battery < 25 OR idle_hours > 60
      ORDER BY idle_hours DESC
      LIMIT 12
    `).all();

    const idleAvg = (sqlite.prepare("SELECT AVG(idle_hours) AS a FROM bikes").get() as any).a;

    return { total, completed, revenue, avgDuration, avgDistance, byDay, parkingCounts, utilisation, problemBikes, idleAvg };
  }

  // Period-scoped analytics powering the admin "Аналитика v1" page. Everything
  // is computed against rides that *started* within [from, to]. Revenue is the
  // sum of settled ride cost (the current ride/tariff data — no real acquiring).
  adminAnalytics(range: { from: number; to: number }) {
    const { from, to } = range;
    const q = (sqlStr: string) =>
      sqlite.prepare(sqlStr).get(from, to) as any;

    // ---- KPI cards (selected period) ----
    const ridesCount = q("SELECT COUNT(*) AS c FROM rides WHERE started_at >= ? AND started_at <= ?").c;
    const activeRides = q("SELECT COUNT(*) AS c FROM rides WHERE status='active' AND started_at >= ? AND started_at <= ?").c;
    const completedRides = q("SELECT COUNT(*) AS c FROM rides WHERE status='completed' AND started_at >= ? AND started_at <= ?").c;
    const revenue = q("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed' AND started_at >= ? AND started_at <= ?").s;
    const avgDuration = q("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed' AND ended_at IS NOT NULL AND started_at >= ? AND started_at <= ?").a;
    // Average check = revenue per completed (paid) ride in the period.
    const avgCheck = completedRides > 0 ? revenue / completedRides : 0;
    const newUsers = q("SELECT COUNT(*) AS c FROM users WHERE created_at >= ? AND created_at <= ?").c;
    const usersWithRides = q("SELECT COUNT(DISTINCT user_id) AS c FROM rides WHERE started_at >= ? AND started_at <= ?").c;
    const openTickets = (sqlite.prepare(
      `SELECT COUNT(*) AS c FROM tickets WHERE status NOT IN ('resolved','closed','cancelled')`,
    ).get() as any).c;

    // ---- Rides per day (within the period) for the trend chart ----
    const byDay = sqlite.prepare(`
      SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
             COUNT(*) AS rides_count,
             COALESCE(SUM(CASE WHEN status='completed' THEN cost ELSE 0 END),0) AS revenue
      FROM rides
      WHERE started_at >= ? AND started_at <= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(from, to) as any[];

    // ---- Top bikes (most rides) and zero-ride bikes in the period ----
    const ridesByBike = new Map<string, number>();
    for (const row of sqlite.prepare(
      "SELECT bike_id, COUNT(*) AS c FROM rides WHERE started_at >= ? AND started_at <= ? GROUP BY bike_id",
    ).all(from, to) as any[]) {
      ridesByBike.set(row.bike_id, row.c);
    }
    const liveBikes = this.listBikes(); // excludes archived
    const topBikes = liveBikes
      .map((b) => ({ id: b.id, model: b.model, status: b.status, rides: ridesByBike.get(b.id) ?? 0 }))
      .sort((a, b) => b.rides - a.rides)
      .slice(0, 10);
    const zeroRideBikes = liveBikes
      .filter((b) => (ridesByBike.get(b.id) ?? 0) === 0)
      .map((b) => ({ id: b.id, model: b.model, status: b.status, idleHours: b.idleHours }))
      .sort((a, b) => b.idleHours - a.idleHours);

    // ---- Users summary ----
    const totalUsers = (sqlite.prepare("SELECT COUNT(*) AS c FROM users").get() as any).c;
    const blockedUsers = (sqlite.prepare("SELECT COUNT(*) AS c FROM users WHERE blocked_at IS NOT NULL").get() as any).c;
    const usersSummary = { total: totalUsers, newInPeriod: newUsers, withRidesInPeriod: usersWithRides, blocked: blockedUsers };

    // ---- Service stats (whole-fleet snapshot; tickets are operational, not period-bound) ----
    const ticketsByPriority = sqlite.prepare(
      "SELECT priority, COUNT(*) AS c FROM tickets GROUP BY priority",
    ).all() as any[];
    const ticketsByStatus = sqlite.prepare(
      "SELECT status, COUNT(*) AS c FROM tickets GROUP BY status",
    ).all() as any[];
    const ticketsByKind = sqlite.prepare(
      "SELECT kind, COUNT(*) AS c FROM tickets GROUP BY kind ORDER BY c DESC",
    ).all() as any[];
    // Repeated-problem bikes: more than one ticket ever logged against them.
    const repeatedProblemBikes = sqlite.prepare(`
      SELECT bike_id, COUNT(*) AS tickets,
             SUM(CASE WHEN status NOT IN ('resolved','closed','cancelled') THEN 1 ELSE 0 END) AS open
      FROM tickets
      GROUP BY bike_id
      HAVING COUNT(*) > 1
      ORDER BY tickets DESC
      LIMIT 12
    `).all() as any[];

    // ---- Parking usage (proximity of ride starts in the period) ----
    const periodStarts = sqlite.prepare(
      "SELECT start_lat, start_lng FROM rides WHERE started_at >= ? AND started_at <= ?",
    ).all(from, to) as any[];
    const parkingUsage = this.listParkings().map((p) => {
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

import {
  bikes, locks, parkings, zones, rides, tickets, ticketComments, payments, wallet, mapObjects, users,
  otpRequests, phoneChangeRequests, emailChangeRequests, oauthIdentities,
  paymentMethods, supportTickets, paymentOrders, walletTopupOrders,
  supportConversations, supportMessages,
  TICKET_CLOSED_STATUSES,
} from "@shared/schema";
import type {
  Bike, Parking, ZoneRow, Ride, AdminRide, Ticket, TicketComment, TicketWithComments, Payment, Wallet,
  MapObject, InsertMapObject, User, OtpRequest, UserRole, UpdateProfileInput,
  PhoneChangeRequest, EmailChangeRequest, OauthIdentity, OauthProvider,
  PaymentMethod, SupportTicket, SupportTicketWithUser, SupportTicketStatus, PaymentOrder,
  AdminCreateBikeInput, AdminUpdateBikeInput, CreateTicketInput, UpdateTicketInput,
  AdminCreateParkingInput, AdminUpdateParkingInput,
  SupportConversation, SupportMessage, SupportMessageRole, AdminSupportConversationRow,
  Lock, AdminCreateLockInput, AdminUpdateLockInput, WalletTopupOrder,
} from "@shared/schema";
import { CONSENT_VERSION } from "@shared/schema";
import { randomUUID, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import {
  PARKINGS, OPERATING_ZONE, SLOW_ZONES, FORBIDDEN_ZONES, MAP_W, MAP_H,
  TARIFFS, tariffPriceKopecks, findNearestParkingWithinRadius,
} from "@shared/geo";
import { computeOverage, finalRideCost, formatKopecksAsRubles } from "@shared/billing";
import { eq, desc, sql, gt, and, asc, inArray, isNull } from "drizzle-orm";
import { EventEmitter } from "node:events";
import { sendToUserAsync } from "./push";
import { encryptToken, decryptToken, hashTokenForLookup } from "./crypto/payment-tokens";
import { getLockGateway } from "./omni/gateway";
import { log } from "./logger";
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

// Флот-шина: единый broadcast-канал "fleet". Эмитится при ЛЮБОМ изменении
// набора/статуса велосипедов (старт/конец аренды, бронь, освобождение брони,
// правки из админки). Открытые админ-страницы и карта подписываются на SSE и
// перезапрашивают список сразу, а не по таймеру.
export const bikeEvents = new EventEmitter();
bikeEvents.setMaxListeners(0);
export const BIKE_EVENT_CHANNEL = "fleet";


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
  // 6-digit numeric code (000000–999999) — matches the SMS copy and UI input.
  // Zero-padded so every code is exactly six digits (audit M6).
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// Payment-method rows store RebillId/AccountToken encrypted at rest (audit
// HIGH #9, see server/crypto/payment-tokens.ts). Every read path funnels
// through these so the rest of the app keeps working with plaintext values
// in memory — only the DB ever sees ciphertext.
function decryptPaymentMethodRow<T extends PaymentMethod | undefined>(row: T): T {
  if (!row) return row;
  return { ...row, rebillId: decryptToken(row.rebillId), accountToken: decryptToken(row.accountToken) };
}
function decryptPaymentMethodRows(rows: PaymentMethod[]): PaymentMethod[] {
  return rows.map((r) => decryptPaymentMethodRow(r));
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

// IStorage is split into domain-segmented sub-interfaces; re-exported for callers.
export type { IStorage } from "./storage/interfaces";
import type { IStorage } from "./storage/interfaces";

// map_objects.points хранится как JSON-строка — парсим перед отдачей
// клиенту, чтобы везде API возвращал [number, number][], а не string.
function hydrateMapObject<T extends { points: unknown }>(row: T): T {
  if (typeof (row as any).points === "string") {
    try { (row as any).points = JSON.parse((row as any).points); }
    catch { (row as any).points = []; }
  }
  return row;
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
  // По умолчанию также шлём fleet-событие (админка/карта обновятся).
  // silent:true — для position-only обновлений во время поездки (каждая
  // GPS-точка), чтобы не спамить стрим флота — статус там не меняется.
  invalidateBikesCache(opts?: { silent?: boolean }): void {
    this._bikesCache = null;
    this._bikesCacheAt = 0;
    if (!opts?.silent) bikeEvents.emit(BIKE_EVENT_CHANNEL);
  }

  // Apply the env-driven admin override so callers always see the effective
  // role without each one re-checking ADMIN_PHONE_NUMBERS.
  private withResolvedRole(user: User | undefined): User | undefined {
    if (!user) return user;
    return { ...user, role: resolveRole(user) };
  }

  async getUser(id: string) {
    const u = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0] as User | undefined;
    if (u?.deletedAt) return undefined;
    return this.withResolvedRole(u);
  }

  async getUserByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    const u = (await db.select().from(users)
      .where(and(eq(users.phone, normalized), isNull(users.deletedAt))).limit(1))[0] as User | undefined;
    return this.withResolvedRole(u);
  }

  // Self-service profile update for the current user. Only the display name is
  // mutable here; phone changes go through SMS OTP and email changes go
  // through email OTP (RuSender). Neither is accepted on this endpoint.
  async updateProfile(id: string, patch: UpdateProfileInput) {
    const existing = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0] as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };

    const set: Partial<User> = { updatedAt: Date.now() };
    if (patch.name !== undefined) set.name = patch.name.trim();
    await db.update(users).set(set as any).where(eq(users.id, id));
    return { user: (await this.getUser(id))! };
  }

  /**
   * Account erasure keeps the user primary key solely as a pseudonymous
   * reference from immutable ride/payment ledger rows. It deliberately does
   * not delete completed rides, ride points, payments, payment orders, or the
   * wallet, because those rows are required for accounting and audit.
   */
  async deleteAccount(userId: string): Promise<{ ok: true } | { error: "active_ride" | "not_found" }> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const user = (await client.query<{ phone: string; deleted_at: number | null }>(
        `SELECT phone, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
      )).rows[0];
      if (!user || user.deleted_at) {
        await client.query("ROLLBACK");
        return { error: "not_found" };
      }

      const activeRide = (await client.query(
        `SELECT 1 FROM rides WHERE user_id = $1 AND status = 'active' LIMIT 1`,
        [userId],
      )).rowCount;
      if (activeRide) {
        await client.query("ROLLBACK");
        return { error: "active_ride" };
      }

      const now = Date.now();
      // Pending contact verification and OAuth/provider metadata contain direct
      // identifiers and have no independent retention requirement.
      await client.query(`DELETE FROM phone_change_requests WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM email_change_requests WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM oauth_identities WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM otp_requests WHERE phone = $1`, [user.phone]);

      // Payment methods should already have been unlinked from the acquirer by
      // the HTTP layer. This removes legacy/failed metadata if an older row was
      // not eligible for a remote unlink.
      await client.query(`DELETE FROM payment_methods WHERE user_id = $1`, [userId]);

      // Support content can itself contain PII and is not a financial ledger.
      // support_messages cascades from its conversation; sender_id cleanup also
      // covers any legacy message that is not attached to a current conversation.
      await client.query(`DELETE FROM support_tickets WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM support_conversations WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM support_messages WHERE sender_id = $1`, [userId]);

      // A RebillId can authorize future charges and must never outlive the
      // account. Keep the order itself for accounting, but sever the reusable
      // payment-method link/token.
      await client.query(
        `UPDATE payment_orders
         SET payment_method_id = NULL, rebill_id = NULL, updated_at = $2
         WHERE user_id = $1`,
        [userId, now],
      );

      // Users.name and users.phone are NOT NULL in the deployed schema. Replace
      // them with non-identifying values rather than weakening historical DB
      // constraints; email, consent IP and all other profile PII become NULL.
      await client.query(
        `UPDATE users
         SET name = 'Удалённый пользователь',
             phone = 'deleted:' || id,
             email = NULL,
             email_verified_at = NULL,
             consent_accepted_at = NULL,
             consent_version = NULL,
             consent_ip = NULL,
             blocked_at = NULL,
             blocked_reason = NULL,
             deleted_at = $2,
             updated_at = $2
         WHERE id = $1`,
        [userId, now],
      );

      // Delete all persisted sessions for this user, including sessions on
      // other devices. connect-pg-simple creates this table lazily, so account
      // deletion must also work before the first session has been written.
      const sessionTable = (await client.query<{ session_table: string | null }>(
        `SELECT to_regclass('public.session')::text AS session_table`,
      )).rows[0]?.session_table;
      if (sessionTable) {
        await client.query(`DELETE FROM "session" WHERE sess::jsonb ->> 'userId' = $1`, [userId]);
      }

      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------- Admin user management ----------
  // List every registered user, newest first, with effective roles applied so
  // the admin table shows the same role the rest of the app enforces (the
  // ADMIN_PHONE_NUMBERS override can make a stored "rider" effectively admin).
  // Optional limit/offset let callers page the list (audit M5). When no limit is
  // given the full list is returned (preserves consumers that need every row:
  // client-side search, CSV export). The HTTP layer clamps limit to a sane max.
  async listUsers(opts?: { limit?: number; offset?: number }) {
    let q = db.select().from(users).where(isNull(users.deletedAt)).orderBy(desc(users.createdAt)).$dynamic();
    if (opts?.limit !== undefined) q = q.limit(opts.limit).offset(opts.offset ?? 0);
    const rows = (await q) as User[];
    return rows.map((u) => this.withResolvedRole(u)!);
  }

  async countUsers() {
    return Number((await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE deleted_at IS NULL")).rows[0].c);
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
    // Audit HIGH #16: two verifyOtp calls for the same phone can both read
    // `existing` as undefined (no row lock on the SELECT above) and both
    // reach this INSERT. The DB-level partial unique index on active phones
    // (bootstrap.ts) makes the loser fail with 23505 instead of creating a
    // duplicate account — fall back to the row the winner just created so
    // the loser's caller still gets a valid, usable account.
    try {
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
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
    }
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
    // Audit HIGH #16: the read-then-write above still leaves a window between
    // the recheck and this UPDATE. The DB-level partial unique index on
    // active phones (bootstrap.ts) is the actual guarantee — on the rare
    // double-loss race, surface the exact same error the pre-check above
    // already returns instead of a raw 500.
    try {
      await db.update(users).set({ phone: req.newPhone, updatedAt: Date.now() } as any).where(eq(users.id, userId));
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      return { error: "Этот номер уже используется другим аккаунтом" };
    }
    return { user: (await this.getUser(userId))! };
  }

  // ---------- Email change (RuSender OTP) ----------
  // Mirrors the phone-change flow: step 1 sends a 4-digit code by email; step 2
  // verifies it and applies `users.email` + `users.emailVerifiedAt`. The profile
  // PATCH endpoint no longer accepts email — this is the only path.
  async startEmailChange({ userId, email }: { userId: string; email: string }) {
    const user = await this.getUser(userId);
    if (!user) return { error: "Пользователь не найден" };

    const newEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return { error: "Введите корректный email" };
    }
    if (newEmail === (user.email || "").toLowerCase() && user.emailVerifiedAt) {
      return { error: "Этот email уже подтверждён" };
    }

    // Don't allow merging into another verified account's email.
    const taken = (await db.select().from(users).where(eq(users.email, newEmail)).limit(1))[0] as User | undefined;
    if (taken && taken.id !== userId && taken.emailVerifiedAt) {
      return { error: "Этот email уже используется другим аккаунтом" };
    }

    const now = Date.now();
    const existing = (await db.select().from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId)).limit(1))[0] as EmailChangeRequest | undefined;
    if (existing && !existing.consumed) {
      const sinceLast = now - existing.lastSentAt;
      if (sinceLast < OTP_RESEND_LOCK_MS) {
        const retryAfterSec = Math.ceil((OTP_RESEND_LOCK_MS - sinceLast) / 1000);
        return { error: `Повторная отправка кода будет доступна через ${retryAfterSec} с`, retryAfterSec };
      }
    }

    const code = generateOtp();
    const codeHash = hashOtp(newEmail, code);
    const expiresAt = now + OTP_TTL_MS;
    await db.insert(emailChangeRequests)
      .values({ userId, newEmail, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: emailChangeRequests.userId,
        set: { newEmail, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      });

    return { ok: true as const, email: newEmail, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  async verifyEmailChange({ userId, code }: { userId: string; code: string }) {
    const req = (await db.select().from(emailChangeRequests)
      .where(eq(emailChangeRequests.userId, userId)).limit(1))[0] as EmailChangeRequest | undefined;
    if (!req || req.consumed) return { error: "Запросите код подтверждения заново" };
    if (Date.now() > req.expiresAt) return { error: "Срок действия кода истёк. Запросите новый код" };
    if (req.attempts >= OTP_MAX_ATTEMPTS) return { error: "Слишком много попыток. Запросите новый код" };

    const provided = hashOtp(req.newEmail, code.trim());
    if (!safeEqualHex(provided, req.codeHash)) {
      const attempts = req.attempts + 1;
      await db.update(emailChangeRequests).set({ attempts }).where(eq(emailChangeRequests.userId, userId));
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Re-check the email is still free (race with another account).
    const taken = (await db.select().from(users).where(eq(users.email, req.newEmail)).limit(1))[0] as User | undefined;
    if (taken && taken.id !== userId && taken.emailVerifiedAt) {
      return { error: "Этот email уже используется другим аккаунтом" };
    }

    const now = Date.now();
    await db.update(emailChangeRequests).set({ consumed: true }).where(eq(emailChangeRequests.userId, userId));
    // Audit HIGH #16: same read-then-write race as verifyPhoneChange above.
    // The DB-level partial unique index on verified emails (bootstrap.ts) is
    // the actual guarantee — surface the same error as the pre-check on the
    // rare double-loss race instead of a raw 500.
    try {
      await db.update(users)
        .set({ email: req.newEmail, emailVerifiedAt: now, updatedAt: now } as any)
        .where(eq(users.id, userId));
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      return { error: "Этот email уже используется другим аккаунтом" };
    }
    return { user: (await this.getUser(userId))! };
  }

  // Clear the rider's email. Only allowed when they have another way to log in
  // (phone always exists), so we don't check that here. Also clears the pending
  // change request if any.
  async unlinkEmail(userId: string) {
    const user = await this.getUser(userId);
    if (!user) return { error: "Пользователь не найден" };
    const now = Date.now();
    await db.delete(emailChangeRequests).where(eq(emailChangeRequests.userId, userId));
    await db.update(users)
      .set({ email: null, emailVerifiedAt: null, updatedAt: now } as any)
      .where(eq(users.id, userId));
    return { user: (await this.getUser(userId))! };
  }

  // ---------- OAuth identities (Yandex ID / VK ID) ----------
  async listOauthIdentities(userId: string): Promise<OauthIdentity[]> {
    return (await db.select().from(oauthIdentities)
      .where(eq(oauthIdentities.userId, userId))
      .orderBy(desc(oauthIdentities.createdAt))) as OauthIdentity[];
  }

  // UPSERT — a given (provider, subject) can only ever map to one user. If the
  // identity already exists for THIS user we refresh the snapshot; if it exists
  // for a DIFFERENT user we reject rather than silently reassign.
  async linkOauthIdentity(params: {
    userId: string; provider: OauthProvider; subject: string;
    email?: string | null; displayName?: string | null;
  }) {
    const { userId, provider, subject } = params;
    const email = params.email ?? null;
    const displayName = params.displayName ?? null;

    const existing = (await db.select().from(oauthIdentities)
      .where(and(eq(oauthIdentities.provider, provider), eq(oauthIdentities.subject, subject)))
      .limit(1))[0] as OauthIdentity | undefined;

    if (existing && existing.userId !== userId) {
      return { error: "Этот аккаунт уже привязан к другому пользователю" };
    }
    if (existing) {
      await db.update(oauthIdentities)
        .set({ email, displayName } as any)
        .where(eq(oauthIdentities.id, existing.id));
      return { ok: true as const, identity: { ...existing, email, displayName } };
    }

    const row = (await db.insert(oauthIdentities).values({
      userId, provider, subject, email, displayName, createdAt: Date.now(),
    }).returning())[0] as OauthIdentity;
    return { ok: true as const, identity: row };
  }

  async unlinkOauthIdentity(userId: string, provider: OauthProvider) {
    await db.delete(oauthIdentities)
      .where(and(eq(oauthIdentities.userId, userId), eq(oauthIdentities.provider, provider)));
    return { ok: true as const };
  }

  // For unauthenticated OAuth callbacks: look up an existing user by identity,
  // falling back to verified-email match. Returns null when no match — in that
  // case OAuth cannot be used to create a session because we require a phone.
  async findUserByOauth(provider: OauthProvider, subject: string, email?: string | null): Promise<User | null> {
    const identity = (await db.select().from(oauthIdentities)
      .where(and(eq(oauthIdentities.provider, provider), eq(oauthIdentities.subject, subject)))
      .limit(1))[0] as OauthIdentity | undefined;
    if (identity) {
      return (await this.getUser(identity.userId)) ?? null;
    }
    if (email) {
      const normalized = email.trim().toLowerCase();
      const byEmail = (await db.select().from(users).where(eq(users.email, normalized)).limit(1))[0] as User | undefined;
      if (byEmail && byEmail.emailVerifiedAt) {
        return byEmail;
      }
    }
    return null;
  }

  // ---------- Payment methods (MVP metadata only) ----------
  async listPaymentMethods(userId: string) {
    return decryptPaymentMethodRows((await db.select().from(paymentMethods)
      .where(eq(paymentMethods.userId, userId))
      .orderBy(desc(paymentMethods.createdAt))) as PaymentMethod[]);
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
    return decryptPaymentMethodRow((await db.select().from(paymentMethods).where(eq(paymentMethods.id, id)).limit(1))[0] as
      | PaymentMethod
      | undefined);
  }

  // The most recent pending T-Bank card binding for a user. Used by the
  // notification handler to attach the confirmed card to the binding the rider
  // just started.
  async findPendingCardMethod(userId: string) {
    return decryptPaymentMethodRow((await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'pending'`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined);
  }

  // Locate a T-Bank card-binding method by the Init OrderId echoed back in the
  // payment notification. This is how the webhook correlates a verification
  // payment to the pending method (the Init flow has no RequestKey).
  async findCardMethodByOrderId(orderId: string) {
    return decryptPaymentMethodRow((await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.provider} = 'tbank' AND ${paymentMethods.orderId} = ${orderId}`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined);
  }

  // Locate a user's T-Bank card method by its AddCard RequestKey. Used to
  // resolve the method a rider was redirected back from (the Success/Fail URL
  // carries the RequestKey) so we can refresh exactly that binding.
  async findCardMethodByRequestKey(userId: string, requestKey: string) {
    return decryptPaymentMethodRow((await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.requestKey} = ${requestKey}`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined);
  }

  // Locate any T-Bank method by RequestKey alone (no user scope). The SBP
  // binding notification carries a RequestKey but not our user id, so this is
  // how the webhook attaches the AccountToken to the right pending row.
  async findMethodByRequestKey(requestKey: string) {
    return decryptPaymentMethodRow((await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.provider} = 'tbank' AND ${paymentMethods.requestKey} = ${requestKey}`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined);
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
    return decryptPaymentMethodRow((await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'active' AND ${paymentMethods.accountToken} IS NOT NULL AND ${paymentMethods.accountToken} != ''`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined);
  }

  // Atomically claim the right to reverse/refund a card-binding verification
  // charge for this method. Returns true only for the ONE caller that wins the
  // race; every other concurrent caller gets false and must not call /Cancel.
  //
  // Why this exists: activation can be observed by MULTIPLE independent code
  // paths for the very same row — the notification webhook
  // (handleInitBindingNotification) AND the rider's own client-side polling
  // (GET /api/payments/tbank/refresh-bind/:id, hit every ~2s from more than one
  // concurrent useEffect poll loop on the client while the binding modal is
  // open). Both paths call refundVerificationCharge() as soon as THEY see
  // outcome === "active", with no coordination between them. Before this guard,
  // refundVerificationCharge() unconditionally wrote refundStatus="pending" and
  // fired tbankRefundVerificationCharge() (which itself retries /Cancel up to 3
  // times), so two overlapping "active" observations could each independently
  // fire their own 3-attempt /Cancel retry loop against T-Bank for the SAME
  // PaymentId — a plain UPDATE...WHERE id=? has no compare-and-swap semantics,
  // so there was nothing to stop it. This is consistent with production logs
  // showing interleaved "refund attempt 1/3 failed" / "refund OK" / "refund
  // attempt 2/3 failed" / "refund attempt 3/3 failed" / "refund GIVE UP" lines
  // for a single PaymentId, in the same few hundred milliseconds — the
  // signature of two overlapping retry loops, not one.
  //
  // The fix: a single atomic UPDATE ... WHERE refund_status IS NULL OR NOT IN
  // ('pending','refunded') ... RETURNING id. Only the caller whose UPDATE
  // actually matched a row (i.e. observed a "claimable" refundStatus and
  // transitioned it) may proceed to call T-Bank; every other concurrent caller
  // sees zero rows updated and must back off. This is safe to call repeatedly:
  // a method whose refund already failed (refundStatus="failed") can still be
  // re-claimed for a retry (by the periodic poll or a manual re-check), since
  // "failed" is not in the "already claimed" set — that preserves the existing
  // stuck-1-rouble recovery behavior while still preventing true concurrent
  // double-fire.
  async claimRefund(methodId: number): Promise<boolean> {
    const result = await db.update(paymentMethods)
      .set({ refundStatus: "pending", refundError: null, updatedAt: Date.now() } as any)
      .where(sql`${paymentMethods.id} = ${methodId} AND (
        ${paymentMethods.refundStatus} IS NULL
        OR ${paymentMethods.refundStatus} NOT IN ('pending', 'refunded')
      )`)
      .returning({ id: paymentMethods.id });
    return result.length > 0;
  }

  async updatePaymentMethod(id: number, patch: Partial<PaymentMethod>) {
    const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
    delete set.id;
    // Audit HIGH #9: encrypt RebillId/AccountToken before they ever touch the
    // DB — this is the single write path for both fields, so every caller
    // (webhook handlers, refresh routes) is covered without changes on their
    // end. The blind-index (hash) column is derived alongside so the dedup
    // lookup below — and getActiveSavedCard/getActiveSavedSbp's NOT NULL
    // checks — keep working without ever decrypting a whole table scan.
    if ("rebillId" in set) {
      const plain = typeof set.rebillId === "string" ? set.rebillId.trim() : "";
      set.rebillId = plain ? encryptToken(plain) : null;
      set.rebillIdHash = plain ? hashTokenForLookup(plain) : null;
    }
    if ("accountToken" in set) {
      const plain = typeof set.accountToken === "string" ? set.accountToken.trim() : "";
      set.accountToken = plain ? encryptToken(plain) : null;
      set.accountTokenHash = plain ? hashTokenForLookup(plain) : null;
    }
    await db.update(paymentMethods).set(set as any).where(eq(paymentMethods.id, id));
    const updated = await this.getPaymentMethod(id); // decrypted — see decryptPaymentMethodRow

    // Дедупликация: одна и та же физическая карта при повторной привязке возвращает
    // тот же T-Bank CardId (или RebillId). Когда метод становится active с таким
    // идентификатором — удаляем прочие методы того же пользователя с тем же
    // CardId/RebillId, чтобы в списке не копились одинаковые карты. Централизовано
    // здесь — покрывает все пути активации (webhook, refresh, refresh-bind).
    if (updated && updated.status === "active" && updated.userId) {
      const cardId = updated.cardId?.trim();
      const rebillId = updated.rebillId?.trim();
      if (cardId || rebillId) {
        try {
          const conds = [] as any[];
          if (cardId) conds.push(sql`${paymentMethods.cardId} = ${cardId}`);
          // rebillId is encrypted at rest with a random IV, so it can't be matched
          // by equality — compare via the deterministic blind index instead.
          if (rebillId) conds.push(sql`${paymentMethods.rebillIdHash} = ${hashTokenForLookup(rebillId)}`);
          const idMatch = conds.length === 1 ? conds[0] : sql`(${conds[0]} OR ${conds[1]})`;
          await db.delete(paymentMethods).where(
            and(
              eq(paymentMethods.userId, updated.userId),
              sql`${paymentMethods.id} != ${updated.id}`,
              sql`${paymentMethods.type} = ${updated.type}`,
              idMatch,
            ),
          );
        } catch {
          /* дедупликация best-effort — не ломаем основную активацию */
        }
      }
    }
    return updated;
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
    idempotencyKey?: string;
  }) {
    const now = Date.now();
    try {
      return (await db.insert(paymentOrders).values({
        orderId: input.orderId,
        userId: input.userId,
        bikeId: input.bikeId,
        tariffId: input.tariffId,
        amountKopecks: input.amountKopecks,
        source: input.source ?? "hosted",
        paymentMethodId: input.paymentMethodId ?? null,
        // Write-once audit-trail copy (never read back) — encrypted at rest
        // for defense-in-depth consistency with payment_methods (audit HIGH #9).
        rebillId: input.rebillId ? encryptToken(input.rebillId) : null,
        idempotencyKey: input.idempotencyKey ?? null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      } as any).returning())[0] as PaymentOrder;
    } catch (err) {
      // A concurrent request carrying the SAME (userId, idempotencyKey) won the
      // race for the partial unique index (audit HIGH #2) — return its row so
      // the loser replays the winner's order instead of a 500.
      if (input.idempotencyKey && this.isUniqueViolation(err)) {
        const existing = await this.getRidePaymentOrderByIdempotencyKey(input.userId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  // Reserve a ride-payment-order row for a client idempotency key BEFORE the
  // caller talks to the acquirer (audit HIGH #2) — used by the saved-card
  // charge route, where a duplicate call would move real money a second time.
  // `created: false` means a row for this exact (userId, idempotencyKey)
  // already existed (either a prior attempt, or a racing sibling that won the
  // unique-index race); the caller MUST replay that row's state and MUST NOT
  // call tbankInit/tbankCharge again.
  async reserveRidePaymentOrder(input: {
    orderId: string;
    userId: string;
    bikeId: string;
    tariffId: string;
    amountKopecks: number;
    source?: "hosted" | "saved_card";
    paymentMethodId?: number;
    rebillId?: string;
    idempotencyKey: string;
  }): Promise<{ order: PaymentOrder; created: boolean }> {
    const existing = await this.getRidePaymentOrderByIdempotencyKey(input.userId, input.idempotencyKey);
    if (existing) return { order: existing, created: false };
    const now = Date.now();
    try {
      const order = (await db.insert(paymentOrders).values({
        orderId: input.orderId,
        userId: input.userId,
        bikeId: input.bikeId,
        tariffId: input.tariffId,
        amountKopecks: input.amountKopecks,
        source: input.source ?? "hosted",
        paymentMethodId: input.paymentMethodId ?? null,
        // Write-once audit-trail copy (never read back) — encrypted at rest
        // for defense-in-depth consistency with payment_methods (audit HIGH #9).
        rebillId: input.rebillId ? encryptToken(input.rebillId) : null,
        idempotencyKey: input.idempotencyKey,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      } as any).returning())[0] as PaymentOrder;
      return { order, created: true };
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        const raced = await this.getRidePaymentOrderByIdempotencyKey(input.userId, input.idempotencyKey);
        if (raced) return { order: raced, created: false };
      }
      throw err;
    }
  }

  async getRidePaymentOrderByIdempotencyKey(userId: string, idempotencyKey: string) {
    return (await db.select().from(paymentOrders)
      .where(sql`${paymentOrders.userId} = ${userId} AND ${paymentOrders.idempotencyKey} = ${idempotencyKey}`)
      .limit(1))[0] as PaymentOrder | undefined;
  }

  // Resolve the rider's saved T-Bank card eligible for a recurring charge: an
  // active card-type method with a RebillId. When paymentMethodId is given it
  // must belong to the rider and be active with a RebillId; otherwise the most
  // recent qualifying card is returned. Returns undefined when no usable saved
  // card exists (the caller then falls back to the hosted payment flow).
  // Detect a physical-card duplicate just before activating a pending binding.
  // label is always produced by maskPan() as "•••• XXXX", so a four-digit suffix
  // is a safe fingerprint without a schema change. Known brands refine the match;
  // legacy rows with an unknown brand still match by last4 to avoid false
  // negatives. An unknown candidate brand also falls back to last4 alone.
  async findActiveCardDuplicate(
    userId: string,
    last4: string,
    brand: string | null,
    excludeMethodId?: number,
  ) {
    const excludeSql = excludeMethodId != null
      ? sql` AND ${paymentMethods.id} != ${excludeMethodId}`
      : sql``;
    const brandSql = brand != null
      ? sql` AND (${paymentMethods.brand} = ${brand} OR ${paymentMethods.brand} IS NULL)`
      : sql``;
    return decryptPaymentMethodRow((await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId}
        AND ${paymentMethods.type} = 'card'
        AND ${paymentMethods.status} = 'active'
        AND ${paymentMethods.label} LIKE ${`%${last4}`}${brandSql}${excludeSql}`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined);
  }

  async getActiveSavedCard(userId: string, paymentMethodId?: number) {
    if (paymentMethodId != null) {
      const m = await this.getPaymentMethod(paymentMethodId);
      if (!m || m.userId !== userId) return undefined;
      if (m.provider !== "tbank" || m.status !== "active" || !m.rebillId) return undefined;
      return m;
    }
    return decryptPaymentMethodRow((await db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'active' AND ${paymentMethods.rebillId} IS NOT NULL AND ${paymentMethods.rebillId} != ''`)
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1))[0] as PaymentMethod | undefined);
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

  // ---------- T-Bank wallet top-up orders (audit CRITICAL #1 fix) ----------
  // Create a pending top-up order when the rider starts the pay-then-credit
  // flow. The wallet balance is NOT touched here — only the confirmed
  // notification webhook (handleWalletTopupNotification) ever calls topUp().
  async createWalletTopupOrder(input: { orderId: string; userId: string; amountKopecks: number }) {
    const now = Date.now();
    return (await db.insert(walletTopupOrders).values({
      orderId: input.orderId,
      userId: input.userId,
      amountKopecks: input.amountKopecks,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    } as any).returning())[0] as WalletTopupOrder;
  }

  async getWalletTopupOrder(orderId: string) {
    return (await db.select().from(walletTopupOrders)
      .where(eq(walletTopupOrders.orderId, orderId))
      .limit(1))[0] as WalletTopupOrder | undefined;
  }

  async updateWalletTopupOrder(id: number, patch: Partial<WalletTopupOrder>) {
    const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
    delete set.id;
    await db.update(walletTopupOrders).set(set as any).where(eq(walletTopupOrders.id, id));
    return (await db.select().from(walletTopupOrders).where(eq(walletTopupOrders.id, id)).limit(1))[0] as
      | WalletTopupOrder
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
      userId, mode: "bot", createdAt: Date.now(), userUnreadCount: 0, operatorUnreadCount: 0,
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
    } else {
      // operator / bot / system — всё это исходящие к пользователю сообщения →
      // бампаем его счётчик непрочитанного.
      await db.execute(sql`
        UPDATE support_conversations
        SET last_message_at = ${now}, user_unread_count = user_unread_count + 1
        WHERE id = ${input.conversationId}
      `);
    }
    return inserted;
  }

  /** Переключить режим разговора: 'bot' | 'human'. */
  async setSupportMode(conversationId: number, mode: "bot" | "human"): Promise<void> {
    await db.execute(sql`
      UPDATE support_conversations SET mode = ${mode} WHERE id = ${conversationId}
    `);
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
        c.id, c.user_id AS "userId", c.mode, c.last_message_at AS "lastMessageAt",
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

  /** Replaces a bike's parking reference from its latest stored lock position. */
  private async recalculateBikeParking(bike: Pick<Bike, "id" | "lat" | "lng">): Promise<void> {
    const match = findNearestParkingWithinRadius(bike.lat, bike.lng, await this.listParkings());
    await this.updateBike(bike.id, { parkingId: match?.id ?? null });
  }

  // ---------- Bikes: admin CRUD (staff only) ----------
  // Normalize an optional string field: trim, and treat "" as null so blank
  // form inputs clear the column rather than storing an empty string.
  private optStr(v: string | undefined): string | null {
    if (v === undefined) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  }

  // Any registry lock not fitted to a bike is eligible for binding, regardless
  // of connectivity. The TCP gateway creates a registry row directly, so the
  // legacy unassigned_locks discovery buffer cannot be the source of this list.
  // Keep the anti-join while legacy bike.lock_imei bindings exist: it prevents a
  // pre-registry bike binding from being offered again before its registry row is
  // next synchronized.
  async listUnassignedLocks(): Promise<{ imei: string; lastSeen: number | null }[]> {
    return (await pool.query(
      `SELECT l.imei, l.last_seen_at AS "lastSeen" FROM locks l
        WHERE l.bike_id IS NULL
          AND l.status <> 'decommissioned'
          AND NOT EXISTS (SELECT 1 FROM bikes b WHERE b.lock_imei = l.imei)
        ORDER BY l.last_seen_at DESC NULLS LAST, l.created_at DESC`,
    )).rows as { imei: string; lastSeen: number | null }[];
  }

  // ---------- Lock device registry: admin CRUD ----------
  async listLocks(): Promise<Lock[]> {
    return await db.select().from(locks).orderBy(desc(locks.createdAt)) as Lock[];
  }

  async createLock(input: AdminCreateLockInput): Promise<{ lock: Lock } | { error: string }> {
    const bikeId = this.optStr(input.bikeId);
    if (bikeId && !await this.getBike(bikeId)) return { error: "Велосипед не найден" };

    const now = Date.now();
    try {
      const inserted = await db.insert(locks).values({
        imei: input.imei.trim(),
        macAddress: this.optStr(input.macAddress),
        bikeId,
        simIccid: this.optStr(input.simIccid),
        firmwareVersion: this.optStr(input.firmwareVersion),
        apn: this.optStr(input.apn) ?? "cmiot",
        status: input.status ?? "unregistered",
        notes: this.optStr(input.notes),
        createdAt: now,
        updatedAt: now,
      }).returning();
      return { lock: inserted[0] as Lock };
    } catch (err) {
      if (this.isUniqueViolation(err)) return { error: "Замок с таким IMEI уже зарегистрирован" };
      throw err;
    }
  }

  async getLock(id: number): Promise<Lock | undefined> {
    return (await db.select().from(locks).where(eq(locks.id, id)).limit(1))[0] as Lock | undefined;
  }

  /**
   * The current active ride on a bike, if any (audit F-07). Used to stop the
   * admin manual-unlock endpoint from physically opening a bike that is
   * mid-ride for a different rider unless the operator explicitly forces it.
   */
  async getActiveRideForBike(bikeId: string): Promise<Ride | undefined> {
    return (await db.select().from(rides)
      .where(and(eq(rides.bikeId, bikeId), eq(rides.status, "active")))
      .limit(1))[0] as Ride | undefined;
  }

  async updateLock(id: number, patch: AdminUpdateLockInput): Promise<{ lock: Lock } | { error: string }> {
    const existing = (await db.select().from(locks).where(eq(locks.id, id)).limit(1))[0] as Lock | undefined;
    if (!existing) return { error: "Замок не найден" };

    const set: Partial<Lock> = { updatedAt: Date.now() };
    if (patch.bikeId !== undefined) {
      const bikeId = this.optStr(patch.bikeId);
      if (bikeId && !await this.getBike(bikeId)) return { error: "Велосипед не найден" };
      set.bikeId = bikeId;
    }
    if (patch.macAddress !== undefined) set.macAddress = this.optStr(patch.macAddress);
    if (patch.simIccid !== undefined) set.simIccid = this.optStr(patch.simIccid);
    if (patch.firmwareVersion !== undefined) set.firmwareVersion = this.optStr(patch.firmwareVersion);
    if (patch.apn !== undefined) set.apn = this.optStr(patch.apn) ?? "cmiot";
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);

    const updated = await db.update(locks).set(set as any).where(eq(locks.id, id)).returning();
    return { lock: updated[0] as Lock };
  }

  // Device history is retained. DELETE is intentionally a lifecycle transition,
  // not a physical row deletion.
  async decommissionLock(id: number): Promise<{ lock: Lock } | { error: string }> {
    const updated = await db.update(locks).set({
      status: "decommissioned",
      updatedAt: Date.now(),
    }).where(eq(locks.id, id)).returning();
    if (!updated[0]) return { error: "Замок не найден" };
    return { lock: updated[0] as Lock };
  }

  // Postgres unique-violation. Two operators can pick the same freshly
  // discovered lock at the same time; the partial unique index on
  // bikes.lock_imei is what actually decides, and the loser gets told plainly
  // instead of a 500.
  // Drizzle wraps driver errors in a DrizzleQueryError whose own `code` is
  // undefined and keeps the pg error (carrying the SQLSTATE) on `cause`, while
  // a raw pool.query throws that pg error directly. Both shapes reach here, so
  // both are checked — matching only the top level lets a duplicate IMEI
  // written through Drizzle escape as a 500.
  private isUniqueViolation(err: unknown): boolean {
    const code = (e: unknown) => (e as { code?: string } | null | undefined)?.code;
    return code(err) === "23505" || code((err as { cause?: unknown } | null)?.cause) === "23505";
  }

  private static readonly LOCK_TAKEN =
    "Этот замок только что назначили другому велосипеду — выберите другой";

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
    const lockImei = input.lockImei.trim();
    try {
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
        lockImei,
        parkingId,
        notes: this.optStr(input.notes),
        seed: false,
      } as any);
    } catch (err) {
      if (this.isUniqueViolation(err)) return { error: DatabaseStorage.LOCK_TAKEN };
      throw err;
    }
    await this.syncLockRegistryBinding(lockImei, id);
    await this.forgetUnassignedLock(lockImei);
    this.invalidateBikesCache();
    return { bike: (await this.getBike(id))! };
  }

  // The lock is now in the registry, so its discovery row is noise. Best-effort:
  // listUnassignedLocks already excludes assigned IMEIs, so failing to clean up
  // is cosmetic and must not fail the bike that was successfully created.
  private async forgetUnassignedLock(imei: string): Promise<void> {
    try {
      await pool.query("DELETE FROM unassigned_locks WHERE imei = $1", [imei]);
    } catch {
      /* ignore */
    }
  }

  // Keep the registry's explicit bike_id relationship in step with the legacy
  // bikes.lock_imei binding. Rows may be absent for old/manual bindings, so an
  // UPDATE affecting zero rows is intentional and must not reject the bike save.
  private async syncLockRegistryBinding(imei: string, bikeId: string | null): Promise<void> {
    await pool.query(
      `UPDATE locks SET bike_id = $2, updated_at = $3 WHERE imei = $1`,
      [imei, bikeId, Date.now()],
    );
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
    // Swapping the lock resets its live state: the new lock has not connected
    // as this bike yet, and inheriting the old one's "online" would show a dead
    // bike as reachable until the ingest corrects it.
    const swappingLock = patch.lockImei !== undefined && patch.lockImei !== existing.lockImei;
    if (swappingLock) {
      set.lockImei = patch.lockImei!.trim();
      set.lockOnline = false;
      set.lockLastSeen = null;
    }
    try {
      await db.update(bikes).set(set as any).where(eq(bikes.id, id));
    } catch (err) {
      if (this.isUniqueViolation(err)) return { error: DatabaseStorage.LOCK_TAKEN };
      throw err;
    }
    // A manual transition into the rental pool uses the lock's current position,
    // not the operator-selected parking. This deliberately overwrites any
    // parkingId supplied in the same PATCH; the regular parking picker remains
    // available for overrides when the bike is not transitioning to available.
    if (patch.status === "available" && existing.status !== "available") {
      await this.recalculateBikeParking(existing);
    }
    if (swappingLock) {
      if (existing.lockImei) await this.syncLockRegistryBinding(existing.lockImei, null);
      await this.syncLockRegistryBinding(set.lockImei!, id);
      await this.forgetUnassignedLock(set.lockImei!);
    }
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
    // «Занято» считается динамически: число велосипедов, у которых эта
    // парковка указана как домашняя И которые физически на месте.
    // Арендованный/архивный велосипед стойку не занимает. Перекрывает
    // статичное поле occupied из БД — оно больше не ведётся вручную.
    const bikeRows = await this.listBikes({ includeArchived: false });
    const AT_STATION = new Set(["available", "reserved", "maintenance", "offline", "storage"]);
    const counts = new Map<string, number>();
    for (const b of bikeRows) {
      if (!b.parkingId) continue;
      if (!AT_STATION.has(b.status)) continue;
      counts.set(b.parkingId, (counts.get(b.parkingId) ?? 0) + 1);
    }
    return rows.map((p) => ({ ...p, occupied: counts.get(p.id) ?? 0 }));
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
      city: input.city,
      lat: input.lat,
      lng: input.lng,
      capacity: input.capacity,
      occupied,
      radius: input.radius,
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
    if (patch.city !== undefined) set.city = patch.city;
    if (patch.lat !== undefined) set.lat = patch.lat;
    if (patch.lng !== undefined) set.lng = patch.lng;
    if (patch.capacity !== undefined) set.capacity = patch.capacity;
    if (patch.occupied !== undefined) set.occupied = patch.occupied;
    if (patch.radius !== undefined) set.radius = patch.radius;
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

  // Audit HIGH #15: this used to always run on the global `pool` (a plain
  // pool.query), even when called from inside an already-open `db.transaction`
  // (endRide below). A raw pool.query grabs a SEPARATE connection instead of
  // reusing the transaction's own client, so it can't see the tx's
  // uncommitted writes/snapshot, and — worse — it holds a second pool slot for
  // the lifetime of a transaction that's already holding one. With N
  // concurrent endRide calls against a pool of size N, every connection is
  // pinned by an open transaction waiting on this second query, which itself
  // has no free connection left to run on — deadlock by connection
  // exhaustion. Callers inside a transaction MUST now pass their `tx` so this
  // reuses the same client/snapshot instead of reaching for the pool.
  private async loadRidePoints(
    rideId: number,
    executor: { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> } = db,
  ): Promise<[number, number, number][]> {
    const result = await executor.execute(
      sql`SELECT x, y, t FROM ride_points WHERE ride_id = ${rideId} ORDER BY id`,
    );
    const rows = result.rows as { x: number; y: number; t: number }[];
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
    // transaction. A bare SELECT inside a transaction does NOT lock the row
    // under Postgres' default READ COMMITTED isolation — two concurrent
    // requests could both read bike.status = 'available' before either
    // commits and both proceed to insert a ride for the same bike
    // (double-booking, audit CRITICAL #4). `.for("update")` takes a row lock
    // on SELECT, so the second transaction blocks here until the first
    // commits, then re-reads the now-current ("rented") row and correctly
    // bails out below — it never reaches the insert.
    //
    // Belt-and-suspenders: `idx_rides_active_bike` / `idx_rides_active_user`
    // (partial UNIQUE indexes, server/db/bootstrap.ts) make a second active
    // ride for the same bike or rider impossible at the database level too,
    // so a future code path that bypasses this lock still cannot double-book
    // — it gets a unique-violation instead, caught below.
    // Captured from inside the transaction so the post-commit unlock step below
    // (audit F-04) knows which physical lock to address without re-querying.
    let lockImei: string | null = null;
    const result = await (async () => {
      try {
        return await db.transaction(async (tx) => {
          const bike = (await tx.select().from(bikes).where(eq(bikes.id, bikeId)).for("update").limit(1))[0] as Bike | undefined;
          if (!bike) return { error: "Велосипед не найден" };
          lockImei = bike.lockImei ?? null;
          if (bike.status !== "available" && bike.status !== "reserved") {
            return { error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` };
          }
          if (bike.battery < 18) return { error: "Низкий заряд замка, выберите другой велосипед" };
          // No row to lock here (the rider may have zero rides), so this read
          // alone cannot be made race-proof the same way — idx_rides_active_user
          // is what actually closes this half of the race; a loser lands on the
          // unique-violation catch below instead of this friendly early return.
          const active = (await tx.select().from(rides)
            .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
            .limit(1))[0] as Ride | undefined;
          if (active) return { error: "У вас уже есть активная поездка" };

          // Internal (non-prepaid) flow: debit the tariff price from the wallet up
          // front, inside the same transaction so a failure rolls the ride back.
          //
          // The debit itself is a single conditional UPDATE (balance = balance -
          // cost WHERE balance >= cost), not a SELECT-then-UPDATE in app code
          // (audit CRITICAL #5). Reading `w.balance` into a JS variable and
          // writing back `w.balance - cost` is a classic lost-update race: a
          // concurrent top-up or an overage charge from another ride ending at
          // the same instant reads the same stale balance, and whichever UPDATE
          // commits last silently overwrites the other's change. A single
          // atomic SQL expression has no such window — Postgres computes
          // `balance - cost` from the current row under the row's own update,
          // so two concurrent debits/credits against the same wallet always
          // both apply, in some serial order, never one clobbering the other.
          if (!prepaid && costKopecks > 0) {
            await tx.execute(sql`
              INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at)
              VALUES (${userId}, 0, 'payg', NULL)
              ON CONFLICT (user_id) DO NOTHING
            `);
            const debited = await tx.execute(sql`
              UPDATE wallet SET balance = balance - ${costKopecks}
              WHERE user_id = ${userId} AND balance >= ${costKopecks}
              RETURNING balance
            `);
            if (debited.rows.length === 0) {
              return { error: "Недостаточно средств на балансе" };
            }
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
      } catch (err) {
        // idx_rides_active_bike / idx_rides_active_user (server/db/bootstrap.ts)
        // are the database-level backstop for this race; this only fires if the
        // FOR UPDATE lock above was somehow bypassed — still fail closed with a
        // friendly message instead of a raw 500.
        if (this.isUniqueViolation(err)) {
          return { error: "Не удалось начать поездку — велосипед уже забронирован или у вас уже есть активная поездка" };
        }
        throw err;
      }
    })();
    // A successful start flipped a bike to "rented" → the public list is stale.
    // Only fire side effects on the success shape (a Ride row, not an error).
    if (result && !("error" in result)) {
      this.invalidateBikesCache();
      rideEvents.emit(userId, "start" as RideEventReason);

      // Audit F-04: the DB transaction above is only half of "starting a ride" —
      // a bike fitted with a smart lock (lockImei set) must actually be physically
      // unlocked, or the rider is charged for a bike they cannot open. Dispatch
      // the unlock AFTER commit (so we never unlock a bike that failed the
      // eligibility/wallet checks), and compensate fully if the lock doesn't
      // confirm — never leave a charged rider with a bike still locked.
      //
      // Bikes with no lockImei (legacy/manual fleet, not yet fitted with a smart
      // lock) skip this entirely — there is nothing to command.
      if (lockImei) {
        let unlocked = false;
        try {
          const gateway = getLockGateway();
          if (!gateway) throw new Error("OMNI gateway is not running");
          const outcome = await gateway.sendUnlockCommand(lockImei, userId);
          unlocked = outcome.success;
        } catch (err) {
          log(`startRide: unlock failed imei=${lockImei} ride=${result.id}: ${(err as Error).message}`);
        }
        if (!unlocked) {
          await this.abortUnstartedRide(result.id, { refundKopecks: !prepaid ? costKopecks : 0 });
          return { error: "Замок не отвечает — выберите другой велосипед или попробуйте через минуту" };
        }
      }
    }
    return result;
  }

  // Compensating rollback for a ride that was created (and, for the internal
  // wallet flow, already paid) but whose physical lock never confirmed the
  // unlock (audit F-04). Idempotent — a no-op if the ride is no longer active
  // (e.g. a concurrent caller already resolved it), so it is always safe to
  // call even if invoked twice.
  //
  // Only refunds the internal wallet debit: a `prepaid` (T-Bank) ride passes
  // refundKopecks = 0 here because the external charge already succeeded on
  // T-Bank's side before startRide ran — reversing that is a real Refund/Cancel
  // API call, not a local ledger credit, and today failures of that kind are
  // deliberately left for manual/support reconciliation, matching how this
  // codebase already treats other post-payment startRide failures (e.g. the
  // bike being taken in a race) in server/payments/tbank-handlers.ts.
  private async abortUnstartedRide(rideId: number, opts: { refundKopecks: number }) {
    const outcome = await db.transaction(async (tx) => {
      const ride = (await tx.select().from(rides).where(eq(rides.id, rideId)).for("update").limit(1))[0] as Ride | undefined;
      if (!ride || ride.status !== "active") return null;
      await tx.update(rides).set({ status: "cancelled", endedAt: Date.now() } as any).where(eq(rides.id, rideId));
      await tx.update(bikes).set({ status: "available", updatedAt: Date.now() } as any).where(eq(bikes.id, ride.bikeId));
      if (opts.refundKopecks > 0) {
        await tx.execute(sql`UPDATE wallet SET balance = balance + ${opts.refundKopecks} WHERE user_id = ${ride.userId}`);
        await tx.insert(payments).values({
          userId: ride.userId, amount: opts.refundKopecks, kind: "ride_charge",
          description: `Возврат за поездку ${ride.bikeId} — замок не открылся`, createdAt: Date.now(),
        });
      }
      return ride;
    });
    if (outcome) {
      this.invalidateBikesCache();
      rideEvents.emit(outcome.userId, "end" as RideEventReason);
    }
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
      /* position-only во время поездки — fleet-событие не нужно (silent ниже) */
      .where(eq(bikes.id, r.bikeId));
    // Position changed → invalidate the map list and push the owning rider a
    // fresh active-ride snapshot (new track point) over SSE. silent: статус не
    // меняется, не будим fleet-стрим на каждую GPS-точку.
    this.invalidateBikesCache({ silent: true });
    rideEvents.emit(r.userId, "point" as RideEventReason);
    return this.hydrateTrack(
      (await db.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride,
    );
  }

  // ---- onboard bike tracker telemetry (independent of the rider's phone) ----
  // The OMNI smart locks are the primary writer and reach bike_telemetry through
  // the TCP ingest process (server/omni/), which batches its own INSERTs. The two
  // methods below serve the manual HTTP ingest path (/api/telemetry/bike) and the
  // ride-track read, and store positions in map space so tracker points merge
  // with the phone-fed ride track.
  async insertBikeTelemetry(bikeId: string, x: number, y: number, t: number) {
    await pool.query(
      "INSERT INTO bike_telemetry (bike_id, x, y, t) VALUES ($1, $2, $3, $4)",
      [bikeId, x, y, t],
    );
    // Keep the fleet's live position fresh from the tracker too, so the ops map
    // reflects the bike even when no phone is relaying points.
    await db.update(bikes).set({ lat: y, lng: x, lastSeen: t, idleHours: 0 } as any)
      .where(eq(bikes.id, bikeId));
    this.invalidateBikesCache({ silent: true });
  }

  // Telemetry points for one bike within [fromT, toT], time-ordered. Used to
  // build the authoritative ride track for the ride's bike + time window.
  //
  // Positionless rows are skipped: a lock's battery check-in, heartbeat or
  // no-satellite-fix report is stored in the same table with NULL x/y, and must
  // not enter a track as a (null, null) point. The partial index
  // idx_bike_telemetry_pos matches this predicate.
  async getBikeTelemetry(bikeId: string, fromT: number, toT: number): Promise<[number, number, number][]> {
    const rows = (await pool.query(
      `SELECT x, y, t FROM bike_telemetry
        WHERE bike_id = $1 AND t >= $2 AND t <= $3 AND x IS NOT NULL AND y IS NOT NULL
        ORDER BY t, id`,
      [bikeId, fromT, toT],
    )).rows as { x: number; y: number; t: number }[];
    return rows.map((p) => [p.x, p.y, p.t]);
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
      // Pass `tx` — see the audit HIGH #15 note on loadRidePoints above.
      const pts: [number, number, number][] = await this.loadRidePoints(rideId, tx);
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
      // Assignment is based only on live, active parkings. Keep it inside the
      // ride-completion transaction, so the bike never becomes available with
      // an outdated parking reference if the transaction rolls back.
      const parkingMatch = findNearestParkingWithinRadius(
        last[1],
        last[0],
        (await tx.select().from(parkings)) as Parking[],
      );
      await tx.update(bikes).set({ parkingId: parkingMatch?.id ?? null } as any)
        .where(eq(bikes.id, r.bikeId));

      // Only the overage is charged at end — the base tariff was already paid at
      // start (wallet debit or T-Bank). Debit the wallet for the extra hours,
      // inside the same tx so it rolls back with everything else on failure.
      if (overageKopecks > 0) {
        // Same atomic-decrement pattern as startRide's wallet debit (audit
        // CRITICAL #5): a single UPDATE ... SET balance = balance - N,
        // never a SELECT-then-UPDATE round trip through a JS variable. The
        // rider still owes the overage even if the balance goes negative
        // (unlike startRide there is no balance check — the ride is already
        // over and must be settled), so this UPDATE is unconditional; the
        // wallet-creation UPSERT just guarantees a row exists to decrement.
        await tx.execute(sql`
          INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at)
          VALUES (${r.userId}, 0, 'payg', NULL)
          ON CONFLICT (user_id) DO NOTHING
        `);
        await tx.execute(sql`
          UPDATE wallet SET balance = balance - ${overageKopecks} WHERE user_id = ${r.userId}
        `);
        await tx.insert(payments).values({
          userId: r.userId, amount: -overageKopecks, kind: "ride_charge",
          description: `Продление аренды ${r.bikeId} • +${extraHours} ч`, createdAt: endedAt,
        });
      }
      return {
        ride: (await tx.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride,
        overageKopecks,
      };
    });
    // Ended ride freed the bike (status "available") → refresh the map list and
    // push a terminal event so the rider's SSE stream sends null (ride over).
    if (result?.ride) {
      this.invalidateBikesCache();
      rideEvents.emit(result.ride.userId, "end" as RideEventReason);
      if (result.overageKopecks > 0) {
        sendToUserAsync(result.ride.userId, {
          title: "Оплата поездки",
          body: `Списано ${formatKopecksAsRubles(result.overageKopecks)} ₽ за поездку. Спасибо, что пользуетесь TakeRide!`,
          url: "/rides",
          tag: `ride:${result.ride.id}:overage`,
          data: { kind: "ride-charge-confirmed", rideId: result.ride.id },
        });
      }
    }
    return result?.ride;
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
  // admin table can show a name/phone instead of a raw user id. Only the riders
  // referenced by this page are fetched (single batched `IN` query) instead of
  // loading the whole users table into memory. Track points are NOT hydrated for
  // the list — the map GPS track is only needed on a single-ride view and is
  // loaded on demand via getRide (audit L5).
  async listAdminRides(opts?: { limit?: number; offset?: number }) {
    const limit = opts?.limit ?? 200;
    const offset = opts?.offset ?? 0;
    const rows = (await db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit).offset(offset)) as Ride[];
    const userIds = Array.from(new Set(rows.map((r) => r.userId)));
    const riders = userIds.length
      ? ((await db.select().from(users).where(inArray(users.id, userIds))) as User[])
      : [];
    const byId = new Map(riders.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = byId.get(r.userId);
      return { ...r, userName: u?.name ?? null, userPhone: u?.phone ?? null } as AdminRide;
    });
  }

  async countRides() {
    return Number((await pool.query("SELECT COUNT(*)::int AS c FROM rides")).rows[0].c);
  }

  async getWallet(userId: string) {
    let w = (await db.select().from(wallet).where(eq(wallet.userId, userId)).limit(1))[0] as Wallet | undefined;
    if (!w) {
      await db.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any);
      w = (await db.select().from(wallet).where(eq(wallet.userId, userId)).limit(1))[0] as Wallet;
    }
    return w;
  }

  // Top up the wallet inside a single DB transaction. The balance change is an
  // atomic SQL increment (`balance = balance + $amount`) via an UPSERT, not a
  // read-then-write in app code, so two concurrent top-ups can never lose an
  // update (audit M2). The payment row is written in the same transaction so a
  // balance change and its ledger entry always land together.
  async topUp(userId: string, amount: number) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const w = (await client.query(
        `INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at)
         VALUES ($1, $2, 'payg', NULL)
         ON CONFLICT (user_id) DO UPDATE SET balance = wallet.balance + $2
         RETURNING user_id AS "userId", balance,
                   active_tariff AS "activeTariff", tariff_expires_at AS "tariffExpiresAt"`,
        [userId, amount],
      )).rows[0] as Wallet;
      const pay = (await client.query(
        `INSERT INTO payments (user_id, amount, kind, description, created_at)
         VALUES ($1, $2, 'topup', $3, $4)
         RETURNING id, user_id AS "userId", amount, kind, description, created_at AS "createdAt"`,
        [userId, amount, `Пополнение баланса карты •• 4242`, Date.now()],
      )).rows[0] as Payment;
      await client.query("COMMIT");
      return { wallet: w, payment: pay };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Purchase a tariff inside a single transaction. The debit is a conditional
  // atomic update (`balance = balance - $price WHERE balance >= $price`): if a
  // concurrent purchase already drained the wallet the update matches no row and
  // we reject, so the balance can never go negative or be double-spent (M2).
  async purchaseTariff(userId: string, tariff: string, price: number, durationMs: number) {
    const expires = Date.now() + durationMs;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows = (await client.query(
        `UPDATE wallet SET balance = balance - $2, active_tariff = $3, tariff_expires_at = $4
         WHERE user_id = $1 AND balance >= $2
         RETURNING user_id AS "userId", balance,
                   active_tariff AS "activeTariff", tariff_expires_at AS "tariffExpiresAt"`,
        [userId, price, tariff, expires],
      )).rows;
      if (rows.length === 0) {
        throw new Error("Недостаточно средств на балансе");
      }
      const w = rows[0] as Wallet;
      const pay = (await client.query(
        `INSERT INTO payments (user_id, amount, kind, description, created_at)
         VALUES ($1, $2, 'tariff_purchase', $3, $4)
         RETURNING id, user_id AS "userId", amount, kind, description, created_at AS "createdAt"`,
        [userId, -price, `Подключён тариф «${tariff}»`, Date.now()],
      )).rows[0] as Payment;
      await client.query("COMMIT");
      return { wallet: w, payment: pay };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async listPayments(userId: string) {
    return (await db.select().from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt))) as Payment[];
  }

  async listTickets(opts?: { limit?: number; offset?: number }) {
    let q = db.select().from(tickets).orderBy(desc(tickets.createdAt)).$dynamic();
    if (opts?.limit !== undefined) q = q.limit(opts.limit).offset(opts.offset ?? 0);
    return (await q) as Ticket[];
  }

  async countTickets() {
    return Number((await pool.query("SELECT COUNT(*)::int AS c FROM tickets")).rows[0].c);
  }

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
        await this.recalculateBikeParking(bike);
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
    const parsed = rows.map(hydrateMapObject);
    return opts?.activeOnly ? parsed.filter((o) => o.active) : parsed;
  }

  async createMapObject(input: InsertMapObject) {
    const row = (await db.insert(mapObjects).values({
      name: input.name,
      type: input.type,
      kind: input.kind,
      color: input.color,
      points: JSON.stringify(input.points),
      active: input.active,
      createdAt: Date.now(),
    }).returning())[0] as MapObject;
    return hydrateMapObject(row);
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
      const row = (await db.select().from(mapObjects).where(eq(mapObjects.id, id)).limit(1))[0] as MapObject | undefined;
      return row ? hydrateMapObject(row) : undefined;
    }
    await db.update(mapObjects).set(set as any).where(eq(mapObjects.id, id));
    const row = (await db.select().from(mapObjects).where(eq(mapObjects.id, id)).limit(1))[0] as MapObject | undefined;
    return row ? hydrateMapObject(row) : undefined;
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

    // Popular parkings — proximity of ride start. Audit HIGH #18: this used to
    // pull EVERY ride's start coordinates into Node and loop parkings×rides
    // (O(P×R), and the ride history only grows). The aggregation itself moves
    // into one SQL query — Postgres still does a nested-loop-shaped join
    // internally, but the full rides table is never pulled across the wire
    // into Node memory, and there's no per-row JS overhead.
    const allParkings = await this.listParkings();
    const rideStartCounts = new Map<string, number>(
      ((await pool.query(`
        SELECT p.id, COUNT(r.id)::int AS c
        FROM parkings p
        LEFT JOIN rides r
          ON sqrt(power(r.start_lng - p.lng, 2) + power(r.start_lat - p.lat, 2)) < 30
        GROUP BY p.id
      `)).rows as { id: string; c: number }[]).map((row) => [row.id, row.c]),
    );
    const parkingCounts = allParkings
      .map((p) => ({ ...p, rideStarts: rideStartCounts.get(p.id) ?? 0 }))
      .sort((a, b) => b.rideStarts - a.rideStarts);

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
    // Audit HIGH #18: same O(P×R) Node loop as analytics() above, moved into
    // one SQL aggregate. The period filter must live in the JOIN's ON clause,
    // not a WHERE after it — a WHERE on r.started_at would turn this into an
    // inner join and drop parkings with zero rides in the period instead of
    // reporting them as rideStarts: 0.
    const parkingRideCounts = new Map<string, number>(
      ((await pool.query(
        `SELECT p.id, COUNT(r.id)::int AS c
         FROM parkings p
         LEFT JOIN rides r
           ON sqrt(power(r.start_lng - p.lng, 2) + power(r.start_lat - p.lat, 2)) < 30
          AND r.started_at >= $1 AND r.started_at <= $2
         GROUP BY p.id`,
        [from, to],
      )).rows as { id: string; c: number }[]).map((row) => [row.id, row.c]),
    );
    const parkingUsage = (await this.listParkings())
      .map((p) => ({
        id: p.id, name: p.name, capacity: p.capacity, occupied: p.occupied,
        rideStarts: parkingRideCounts.get(p.id) ?? 0,
      }))
      .sort((a, b) => b.rideStarts - a.rideStarts);

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

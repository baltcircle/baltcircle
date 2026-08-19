import {
  users, otpRequests, phoneChangeRequests, emailChangeRequests, oauthIdentities,
} from "@shared/schema";
import type { User, UserRole, OtpRequest, PhoneChangeRequest, EmailChangeRequest, OauthIdentity, OauthProvider } from "@shared/schema";
import { CONSENT_VERSION } from "@shared/schema";
import { randomUUID, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { eq, and, lt, isNull, desc } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IOtpStorage, IUserStorage } from "./interfaces";
import { normalizePhone, isAdminPhone } from "./base";

// ---------- OTP policy ----------
export const OTP_TTL_MS = 5 * 60 * 1000;     // code valid 5 minutes
export const OTP_MAX_ATTEMPTS = 5;           // wrong-code tries before lockout
export const OTP_RESEND_LOCK_MS = 60 * 1000; // min seconds between SMS per phone
// Audit MEDIUM (Платежи track): otp_requests/phone_change_requests/
// email_change_requests had no periodic cleanup, so a consumed or abandoned
// row (name, target phone/email, SMS/email provider diagnostics) could sit
// in the DB forever. 48h is long enough for admin GET /api/sms/otp-status to
// still inspect a recently consumed/failed OTP for support purposes, short
// enough that PII doesn't linger indefinitely. See purgeExpiredContactRequests.
export const CONTACT_REQUEST_RETENTION_MS = 48 * 60 * 60 * 1000;

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

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function OtpMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IOtpStorage {
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
    async verifyOtp(
      this: IUserStorage & { isUniqueViolation(err: unknown): boolean },
      { phone, code, consentIp }: { phone: string; code: string; consentIp?: string },
    ): Promise<{ user: User } | { error: string }> {
      const cleanPhone = normalizePhone(phone);

      // Audit: read → consume → update/create ran as separate statements with no
      // transaction, so a crash/error between "consumed=true" and the user
      // upsert could burn the code without ever creating/updating the rider,
      // and two concurrent verifies for the same phone could both read the same
      // stale `attempts` and both write `attempts+1` (lost update — weakens the
      // brute-force limit). Wrapping the whole flow in one transaction with
      // `.for("update")` on the otp_requests row (same pattern as startRide/
      // endRide) fixes both: the row lock serialises concurrent verifies for
      // the same phone — the second call blocks until the first commits, then
      // re-reads the now-current attempts/consumed state — and any failure
      // after "consumed=true" rolls the whole transaction back, so the code is
      // never burned without the rider actually being created/updated.
      const outcome = await (async () => {
        try {
          return await db.transaction(async (tx) => {
            const req = (await tx.select().from(otpRequests)
              .where(eq(otpRequests.phone, cleanPhone)).for("update").limit(1))[0] as OtpRequest | undefined;

            if (!req || req.consumed) {
              return { kind: "error" as const, error: "Запросите код подтверждения заново" };
            }
            if (Date.now() > req.expiresAt) {
              return { kind: "error" as const, error: "Срок действия кода истёк. Запросите новый код" };
            }
            if (req.attempts >= OTP_MAX_ATTEMPTS) {
              return { kind: "error" as const, error: "Слишком много попыток. Запросите новый код" };
            }

            const expected = req.codeHash;
            const provided = hashOtp(cleanPhone, code.trim());
            if (!safeEqualHex(provided, expected)) {
              const attempts = req.attempts + 1;
              await tx.update(otpRequests).set({ attempts }).where(eq(otpRequests.phone, cleanPhone));
              const left = OTP_MAX_ATTEMPTS - attempts;
              return {
                kind: "error" as const,
                error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
              };
            }

            // Correct code — consume the request so it can't be reused.
            await tx.update(otpRequests).set({ consumed: true }).where(eq(otpRequests.phone, cleanPhone));

            // Consent was accepted at OTP start (the API requires consent: true
            // before a code is sent), so record the consent metadata on verify
            // when the rider row is created/refreshed. The verified phone IS the
            // proof of consent.
            const now = Date.now();
            const role: UserRole = isAdminPhone(cleanPhone) ? "admin" : "rider";

            // Reuse an existing rider for this phone (keeps rides/wallet) or
            // create one. Read happens inside the same locked transaction, so no
            // concurrent verify for this phone can interleave here anymore.
            const existing = (await tx.select().from(users).where(eq(users.phone, cleanPhone)).limit(1))[0] as
              | User
              | undefined;
            if (existing) {
              const set: Partial<User> = {
                updatedAt: now,
                consentAcceptedAt: now,
                consentVersion: CONSENT_VERSION,
                consentIp: consentIp ?? existing.consentIp ?? null,
                // Keep an already-elevated role (e.g. operator) but ensure admin
                // phones are promoted. Never silently demote a stored operator/admin.
                role: role === "admin" ? "admin" : (existing.role as UserRole),
              };
              if (existing.name !== req.name) set.name = req.name;
              await tx.update(users).set(set as any).where(eq(users.id, existing.id));
              return { kind: "userId" as const, userId: existing.id };
            }
            const newId = randomUUID();
            await tx.insert(users).values({
              id: newId,
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
            return { kind: "userId" as const, userId: newId };
          });
        } catch (err) {
          // Belt-and-suspenders: the DB-level partial unique index on active
          // phones (bootstrap.ts) still exists for any path that somehow bypasses
          // the row lock above — fall back to the row the winner just created so
          // the loser's caller still gets a valid, usable account instead of 500.
          if (this.isUniqueViolation(err)) return { kind: "raced" as const };
          throw err;
        }
      })();

      if (outcome.kind === "error") return { error: outcome.error };
      if (outcome.kind === "raced") return { user: (await this.getUserByPhone(cleanPhone))! };
      return { user: (await this.getUser(outcome.userId))! };
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

    // Periodic TTL purge for all three OTP-shaped tables (otp_requests,
    // phone_change_requests, email_change_requests). Deletes rows whose last
    // SMS/email dispatch is older than CONTACT_REQUEST_RETENTION_MS, regardless
    // of consumed/expired state — covers both abandoned (never verified) and
    // long-consumed rows. Not done on consume itself: GET /api/sms/otp-status
    // (admin) reads a phone's otp_requests row right after verification to show
    // support the delivery/consumption outcome, so the row must outlive the
    // verify call by a support-reasonable window. Called on a timer from
    // server/index.ts — no external cron, this process already runs 24/7.
    async purgeExpiredContactRequests(): Promise<{ otp: number; phoneChange: number; emailChange: number }> {
      const cutoff = Date.now() - CONTACT_REQUEST_RETENTION_MS;
      const [otp, phoneChange, emailChange] = await Promise.all([
        db.delete(otpRequests).where(lt(otpRequests.lastSentAt, cutoff)).returning({ k: otpRequests.phone }),
        db.delete(phoneChangeRequests).where(lt(phoneChangeRequests.lastSentAt, cutoff)).returning({ k: phoneChangeRequests.userId }),
        db.delete(emailChangeRequests).where(lt(emailChangeRequests.lastSentAt, cutoff)).returning({ k: emailChangeRequests.userId }),
      ]);
      return { otp: otp.length, phoneChange: phoneChange.length, emailChange: emailChange.length };
    }

    // ---------- Phone change (SMS OTP, existing account) ----------
    // Step 1: a logged-in rider requests a code sent to a NEW number. The pending
    // request is keyed by the user id and stores the target phone; the code is
    // stored only as an HMAC. Enforces the same per-request resend lock as
    // registration and refuses a number already used by another account.
    async startPhoneChange({ userId, phone }: { userId: string; phone: string }) {
      // Audit: soft-delete scope gap — deleteAccount already revokes every
      // session for this user, so this path shouldn't be reachable in practice,
      // but the explicit check is defense-in-depth against a stale/forged
      // session outliving the deletion.
      const user = (await db.select().from(users).where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1))[0] as User | undefined;
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
    async verifyPhoneChange(
      this: IUserStorage & { isUniqueViolation(err: unknown): boolean },
      { userId, code }: { userId: string; code: string },
    ): Promise<{ user: User } | { error: string }> {
      // Audit: same non-atomic read → consume → update pattern as verifyOtp,
      // fixed the same way — one transaction, `.for("update")` on the
      // phone_change_requests row. Serialises concurrent verifies for this user
      // (fixes the attempts lost-update) and rolls back the "consumed" flag if
      // the final user UPDATE fails, instead of burning the code for nothing.
      const outcome = await (async () => {
        try {
          return await db.transaction(async (tx) => {
            const req = (await tx.select().from(phoneChangeRequests)
              .where(eq(phoneChangeRequests.userId, userId)).for("update").limit(1))[0] as PhoneChangeRequest | undefined;
            if (!req || req.consumed) return { kind: "error" as const, error: "Запросите код подтверждения заново" };
            if (Date.now() > req.expiresAt) return { kind: "error" as const, error: "Срок действия кода истёк. Запросите новый код" };
            if (req.attempts >= OTP_MAX_ATTEMPTS) return { kind: "error" as const, error: "Слишком много попыток. Запросите новый код" };

            const provided = hashOtp(req.newPhone, code.trim());
            if (!safeEqualHex(provided, req.codeHash)) {
              const attempts = req.attempts + 1;
              await tx.update(phoneChangeRequests).set({ attempts }).where(eq(phoneChangeRequests.userId, userId));
              const left = OTP_MAX_ATTEMPTS - attempts;
              return {
                kind: "error" as const,
                error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
              };
            }

            // Re-check the number is still free (another account could have
            // claimed it between request and verify) inside the same locked
            // transaction, then apply the change.
            const taken = (await tx.select().from(users).where(eq(users.phone, req.newPhone)).limit(1))[0] as User | undefined;
            if (taken && taken.id !== userId) {
              return { kind: "error" as const, error: "Этот номер уже используется другим аккаунтом" };
            }

            await tx.update(phoneChangeRequests).set({ consumed: true }).where(eq(phoneChangeRequests.userId, userId));
            await tx.update(users).set({ phone: req.newPhone, updatedAt: Date.now() } as any).where(eq(users.id, userId));
            return { kind: "ok" as const };
          });
        } catch (err) {
          // Belt-and-suspenders: the DB-level partial unique index on active
          // phones (bootstrap.ts) is the actual cross-user guarantee (the row
          // lock above only serialises verifies for THIS user's request) — on
          // the rare double-loss race, surface the same error as the pre-check.
          if (this.isUniqueViolation(err)) return { kind: "error" as const, error: "Этот номер уже используется другим аккаунтом" };
          throw err;
        }
      })();

      if (outcome.kind === "error") return { error: outcome.error };
      return { user: (await this.getUser(userId))! };
    }

    // ---------- Email change (RuSender OTP) ----------
    // Mirrors the phone-change flow: step 1 sends a 4-digit code by email; step 2
    // verifies it and applies `users.email` + `users.emailVerifiedAt`. The profile
    // PATCH endpoint no longer accepts email — this is the only path.
    async startEmailChange(
      this: IUserStorage,
      { userId, email }: { userId: string; email: string },
    ) {
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

    async verifyEmailChange(
      this: IUserStorage & { isUniqueViolation(err: unknown): boolean },
      { userId, code }: { userId: string; code: string },
    ): Promise<{ user: User } | { error: string }> {
      // Audit: same non-atomic read → consume → update pattern fixed the same
      // way as verifyOtp/verifyPhoneChange — one transaction, `.for("update")`
      // on the email_change_requests row.
      const outcome = await (async () => {
        try {
          return await db.transaction(async (tx) => {
            const req = (await tx.select().from(emailChangeRequests)
              .where(eq(emailChangeRequests.userId, userId)).for("update").limit(1))[0] as EmailChangeRequest | undefined;
            if (!req || req.consumed) return { kind: "error" as const, error: "Запросите код подтверждения заново" };
            if (Date.now() > req.expiresAt) return { kind: "error" as const, error: "Срок действия кода истёк. Запросите новый код" };
            if (req.attempts >= OTP_MAX_ATTEMPTS) return { kind: "error" as const, error: "Слишком много попыток. Запросите новый код" };

            const provided = hashOtp(req.newEmail, code.trim());
            if (!safeEqualHex(provided, req.codeHash)) {
              const attempts = req.attempts + 1;
              await tx.update(emailChangeRequests).set({ attempts }).where(eq(emailChangeRequests.userId, userId));
              const left = OTP_MAX_ATTEMPTS - attempts;
              return {
                kind: "error" as const,
                error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
              };
            }

            // Re-check the email is still free (race with another account) inside
            // the same locked transaction.
            const taken = (await tx.select().from(users).where(eq(users.email, req.newEmail)).limit(1))[0] as User | undefined;
            if (taken && taken.id !== userId && taken.emailVerifiedAt) {
              return { kind: "error" as const, error: "Этот email уже используется другим аккаунтом" };
            }

            const now = Date.now();
            await tx.update(emailChangeRequests).set({ consumed: true }).where(eq(emailChangeRequests.userId, userId));
            await tx.update(users)
              .set({ email: req.newEmail, emailVerifiedAt: now, updatedAt: now } as any)
              .where(eq(users.id, userId));
            return { kind: "ok" as const };
          });
        } catch (err) {
          // Belt-and-suspenders: the DB-level partial unique index on verified
          // emails (bootstrap.ts) is the actual cross-user guarantee — on the
          // rare double-loss race, surface the same error as the pre-check.
          if (this.isUniqueViolation(err)) return { kind: "error" as const, error: "Этот email уже используется другим аккаунтом" };
          throw err;
        }
      })();

      if (outcome.kind === "error") return { error: outcome.error };
      return { user: (await this.getUser(userId))! };
    }

    // Clear the rider's email. Only allowed when they have another way to log in
    // (phone always exists), so we don't check that here. Also clears the pending
    // change request if any.
    async unlinkEmail(this: IUserStorage, userId: string) {
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
    async findUserByOauth(
      this: IUserStorage,
      provider: OauthProvider, subject: string, email?: string | null,
    ): Promise<User | null> {
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
  };
}

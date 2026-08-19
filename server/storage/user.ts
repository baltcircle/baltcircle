import {
  users, rides, phoneChangeRequests, emailChangeRequests, oauthIdentities, pushSubscriptions,
  otpRequests, paymentMethods, supportTickets, supportConversations, supportMessages, paymentOrders,
} from "@shared/schema";
import type { User, UserRole, UpdateProfileInput } from "@shared/schema";
import { eq, and, isNull, sql, desc, count } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IUserStorage } from "./interfaces";
import { resolveRole, normalizePhone } from "./base";

export function UserMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IUserStorage {
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
      // Audit: soft-delete scope gap — without the deletedAt check a caller that
      // still holds a session for an account deleted on another device could
      // resurrect readable profile fields on the anonymized row.
      const existing = (await db.select().from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).limit(1))[0] as User | undefined;
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
      return db.transaction(async (tx) => {
        const user = (await tx.select({ phone: users.phone, deletedAt: users.deletedAt })
          .from(users).where(eq(users.id, userId)).for("update").limit(1))[0];
        if (!user || user.deletedAt) {
          return { error: "not_found" as const };
        }

        const activeRide = (await tx.select({ id: rides.id }).from(rides)
          .where(and(eq(rides.userId, userId), eq(rides.status, "active"))).limit(1))[0];
        if (activeRide) {
          return { error: "active_ride" as const };
        }

        const now = Date.now();
        // Pending contact verification and OAuth/provider metadata contain direct
        // identifiers and have no independent retention requirement.
        await tx.delete(phoneChangeRequests).where(eq(phoneChangeRequests.userId, userId));
        await tx.delete(emailChangeRequests).where(eq(emailChangeRequests.userId, userId));
        await tx.delete(oauthIdentities).where(eq(oauthIdentities.userId, userId));
        await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
        await tx.delete(otpRequests).where(eq(otpRequests.phone, user.phone));

        // Payment methods should already have been unlinked from the acquirer by
        // the HTTP layer. This removes legacy/failed metadata if an older row was
        // not eligible for a remote unlink.
        await tx.delete(paymentMethods).where(eq(paymentMethods.userId, userId));

        // Support content can itself contain PII and is not a financial ledger.
        // support_messages cascades from its conversation; sender_id cleanup also
        // covers any legacy message that is not attached to a current conversation.
        await tx.delete(supportTickets).where(eq(supportTickets.userId, userId));
        await tx.delete(supportConversations).where(eq(supportConversations.userId, userId));
        await tx.delete(supportMessages).where(eq(supportMessages.senderId, userId));

        // A RebillId can authorize future charges and must never outlive the
        // account. Keep the order itself for accounting, but sever the reusable
        // payment-method link/token.
        await tx.update(paymentOrders)
          .set({ paymentMethodId: null, rebillId: null, updatedAt: now })
          .where(eq(paymentOrders.userId, userId));

        // Users.name and users.phone are NOT NULL in the deployed schema. Replace
        // them with non-identifying values rather than weakening historical DB
        // constraints; email, consent IP and all other profile PII become NULL.
        await tx.update(users)
          .set({
            name: "Удалённый пользователь",
            phone: sql`'deleted:' || id`,
            email: null,
            emailVerifiedAt: null,
            consentAcceptedAt: null,
            consentVersion: null,
            consentIp: null,
            blockedAt: null,
            blockedReason: null,
            deletedAt: now,
            updatedAt: now,
          } as any)
          .where(eq(users.id, userId));

        // Delete all persisted sessions for this user, including sessions on
        // other devices. connect-pg-simple creates this table lazily, so account
        // deletion must also work before the first session has been written, and
        // that table has no Drizzle schema (owned by the session-store library) —
        // both checks stay on tx.execute(sql) for that reason.
        const sessionTable = (await tx.execute<{ session_table: string | null }>(sql`
          SELECT to_regclass('public.session')::text AS session_table
        `)).rows[0]?.session_table;
        if (sessionTable) {
          await tx.execute(sql`DELETE FROM "session" WHERE sess::jsonb ->> 'userId' = ${userId}`);
        }

        return { ok: true as const };
      });
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
      return (await db.select({ c: count() }).from(users).where(isNull(users.deletedAt)))[0].c;
    }

    // Audit: soft-delete scope gap — an operator must not be able to promote or
    // demote a deleted account's role; getUser()/withResolvedRole() would just
    // hide the row again on the next read anyway, so silently "succeeding"
    // here was misleading rather than dangerous, but the explicit check makes
    // the admin UI surface a clear error instead of a row that vanishes.
    async setUserRole(id: string, role: UserRole) {
      const existing = (await db.select().from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).limit(1))[0] as User | undefined;
      if (!existing) return { error: "Пользователь не найден" };
      await db.update(users).set({ role, updatedAt: Date.now() } as any).where(eq(users.id, id));
      return { user: (await this.getUser(id))! };
    }

    async setUserBlocked(id: string, blocked: boolean, reason?: string) {
      const existing = (await db.select().from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).limit(1))[0] as User | undefined;
      if (!existing) return { error: "Пользователь не найден" };
      const set: Partial<User> = {
        blockedAt: blocked ? Date.now() : null,
        blockedReason: blocked ? (reason?.trim() || null) : null,
        updatedAt: Date.now(),
      };
      await db.update(users).set(set as any).where(eq(users.id, id));
      return { user: (await this.getUser(id))! };
    }
  };
}

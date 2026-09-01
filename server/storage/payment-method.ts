import { paymentMethods, paymentOrders } from "@shared/schema";
import type { PaymentMethod, PaymentOrder } from "@shared/schema";
import { eq, desc, sql, and, ne } from "drizzle-orm";
import { decryptToken, encryptToken, hashTokenForLookup } from "../crypto/payment-tokens";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IPaymentMethodStorage } from "./interfaces";

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

export function PaymentMethodMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IPaymentMethodStorage {
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
    async createRidePaymentOrder(
      this: {
        isUniqueViolation(err: unknown): boolean;
        getRidePaymentOrderByIdempotencyKey(userId: string, idempotencyKey: string): Promise<PaymentOrder | undefined>;
      },
      input: {
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
      },
    ) {
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
    async reserveRidePaymentOrder(
      this: {
        isUniqueViolation(err: unknown): boolean;
        getRidePaymentOrderByIdempotencyKey(userId: string, idempotencyKey: string): Promise<PaymentOrder | undefined>;
      },
      input: {
        orderId: string;
        userId: string;
        bikeId: string;
        tariffId: string;
        amountKopecks: number;
        source?: "hosted" | "saved_card" | "saved_sbp";
        paymentMethodId?: number;
        rebillId?: string;
        idempotencyKey: string;
        // Set ONLY for a ride-EXTEND charge (never for a ride-start charge). This
        // is the sole discriminator startRideForPaidOrder/extendRideForPaidOrder
        // use to tell the two flows apart once the order is later loaded from a
        // webhook or the synchronous route — it must be present at creation time,
        // not patched in after payment.
        rideId?: number;
        // Server-initiated overage charge at ride-end — see the `purpose` column
        // comment in shared/schema.ts. Also carries a rideId, but must be
        // checked BEFORE the rideId-based extend branch in the webhook.
        purpose?: "ride_overage";
      },
    ): Promise<{ order: PaymentOrder; created: boolean }> {
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
          rideId: input.rideId ?? null,
          purpose: input.purpose ?? null,
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

    // Most recent successfully-PAID saved-card/SBP order for a ride (its start
    // charge OR any later extend charge) — used at settlement to decide which
    // payment method (if any) should be charged for overage. A plain read, no
    // row lock: endRide's own `.for("update")` on the ride row already keeps a
    // concurrent extend from running while settlement is in progress, so this
    // only ever sees a consistent, already-committed history.
    async getLatestPaidRidePaymentOrder(rideId: number) {
      return (await db.select().from(paymentOrders)
        .where(sql`${paymentOrders.rideId} = ${rideId} AND ${paymentOrders.status} = 'paid' AND ${paymentOrders.source} != 'hosted'`)
        .orderBy(desc(paymentOrders.updatedAt))
        .limit(1))[0] as PaymentOrder | undefined;
    }

    // Atomically claim a ride-payment order before starting/extending the ride
    // or writing a terminal status (audit HIGH #6 — race condition). Mirrors
    // WalletMixin.claimWalletTopupOrderForProcessing: two concurrent T-Bank
    // notifications for the same order each load their own `order` snapshot in
    // handleRidePaymentNotification; without this, both could pass the
    // caller's `order.status === "paid"` check and both call
    // startRideForPaidOrder/extendRideForPaidOrder (double ride start / double
    // extend). This UPDATE ... WHERE is a single atomic statement the DB
    // serializes per-row, so only ONE concurrent caller can flip status to
    // "processing" and proceed; the other sees 0 rows affected and must treat
    // it as a no-op. Claiming from "failed" too preserves the existing
    // behaviour where a late CONFIRMED notification can still resolve an order
    // T-Bank had previously reported as rejected.
    async claimRidePaymentOrderForProcessing(id: number) {
      const rows = await db.update(paymentOrders)
        .set({ status: "processing", updatedAt: Date.now() } as any)
        .where(and(
          eq(paymentOrders.id, id),
          ne(paymentOrders.status, "paid"),
          ne(paymentOrders.status, "processing"),
        ))
        .returning();
      return rows[0] as PaymentOrder | undefined;
    }

    async updateRidePaymentOrder(id: number, patch: Partial<PaymentOrder>) {
      const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
      delete set.id;
      await db.update(paymentOrders).set(set as any).where(eq(paymentOrders.id, id));
      return (await db.select().from(paymentOrders).where(eq(paymentOrders.id, id)).limit(1))[0] as
        | PaymentOrder
        | undefined;
    }
  };
}

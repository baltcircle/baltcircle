import type { Response } from "express";
import { storage } from "../storage";
import type { PaymentMethod, PaymentOrder } from "@shared/schema";
import {
  classifyCardBinding, classifyInitBinding, classifyRidePayment,
  classifyAccountBinding,
  tbankInitBindCard, verifyNotificationToken, generateBindOrderId,
  tbankRefundVerificationCharge,
} from "../tbank";
import type { TbankConfig } from "../tbank";
import { log } from "../index";
import { sendToUserAsync } from "../push";

// Start (or reuse) a prepaid ride for a ride-payment order that has just been
// PAID, guarding against a double-start. Shared by the synchronous saved-card
// charge route and the async notification webhook so both paths behave
// identically (audit #8 — the logic was duplicated in two places).
//
// Returns:
//   { ok: true, rideId }            — a ride is running for this order
//   { ok: false, reason }           — payment is kept (order marked paid) but the
//                                     ride could not start (e.g. bike taken); the
//                                     caller decides how to surface `reason`.
// The order row is always updated to "paid" with the resolved rideId (on success)
// or the failure reason (on ride-start failure). Idempotent: an order that
// already carries a rideId reuses it and never starts a second ride.
export async function startRideForPaidOrder(
  order: PaymentOrder,
  paymentId: string,
): Promise<{ ok: true; rideId: number } | { ok: false; reason: string }> {
  let rideId: number | null = order.rideId ?? null;
  if (rideId == null) {
    const existing = await storage.getActiveRide(order.userId);
    if (existing && existing.bikeId === order.bikeId) {
      rideId = existing.id;
    } else {
      const started = await storage.startRide({
        bikeId: order.bikeId,
        userId: order.userId,
        tariff: order.tariffId,
        prepaid: true,
      });
      if ("error" in started) {
        await storage.updateRidePaymentOrder(order.id, {
          status: "paid",
          paymentId: paymentId || order.paymentId,
          lastErrorMessage: started.error,
        });
        return { ok: false, reason: started.error };
      }
      rideId = started.id;
    }
  }
  await storage.updateRidePaymentOrder(order.id, {
    status: "paid",
    paymentId: paymentId || order.paymentId,
    rideId,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorDetails: null,
  });
  return { ok: true, rideId };
}

// Build a sanitized error body for a rejected T-Bank operation. Surfaces the
// acquirer's own ErrorCode / Message / Details so the rider (and support) can
// see *why* the operation failed instead of an opaque generic message. These
// fields are produced by T-Bank and carry no terminal secret (the password is
// never echoed back), so they are safe to forward. A friendly fallback message
// is always provided when T-Bank returns nothing useful.
export function tbankErrorBody(resp: {
  ErrorCode?: string;
  Message?: string;
  Details?: string;
}): { error: string; code?: string; message?: string; details?: string } {
  const code = (resp.ErrorCode ?? "").trim();
  const message = (resp.Message ?? "").trim();
  const details = (resp.Details ?? "").trim();

  // Prefer the acquirer's human message, then its details, then a fallback.
  const error =
    message ||
    details ||
    "Платёжный сервис отклонил операцию. Попробуйте позже или другую карту.";

  return {
    error,
    code: code && code !== "0" ? code : undefined,
    message: message || undefined,
    details: details || undefined,
  };
}

// Process a verified T-Bank notification for card binding. Two binding paths
// produce notifications here:
//   • Init + Recurrent=Y (primary): a verification-payment notification carries
//     OrderId/PaymentId/Status and, once authorized, a RebillId. We correlate by
//     OrderId and activate the method once a RebillId arrives on AUTHORIZED/
//     CONFIRMED.
//   • AddCard (fallback): a notification carrying CardId/Status for a CustomerKey
//     activates (or fails) the rider's pending card method.
//   • Ordinary ride payment (the MVP path): a notification carrying our ride
//     OrderId starts the paid ride once AUTHORIZED/CONFIRMED, or marks the order
//     failed otherwise.
//
// The notification is assumed signature-verified by the caller (verifyNotificationToken
// against our terminal password — so a valid Token means this genuinely came from
// T-Bank for OUR terminal, not a forged request). Statuses follow the T-Kassa
// lifecycle (NEW/FORM_SHOWED/AUTHORIZED/CONFIRMED/REJECTED/...).
//
// IMPORTANT — unmatched-but-validly-signed notifications: T-Bank's own merchant-
// cabinet "Тестировать" dashboard fires real, correctly-signed notifications
// straight at our NotificationURL for test payments it initiates itself (e.g. the
// standard test card 4300 0000 0000 0777), WITHOUT ever calling any of our own
// endpoints first. Such a notification's OrderId/RequestKey/CustomerKey will
// never correlate to a row in our DB — that is expected, not suspicious. A
// validly-signed notification we cannot correlate is treated as informational: we
// log a warning (for reconciliation visibility) and otherwise do nothing. We must
// NEVER call Cancel/Refund merely because we lack a local row for an OrderId —
// only a handler that has ACTUALLY MATCHED a specific order/method to a specific
// notification may ever move money, and only for the reasons already coded into
// that handler (e.g. reversing the small verification hold once binding is
// confirmed). See handleAddCardNotification below for the corresponding no-op on
// an unmatched CustomerKey.
export async function handleTbankNotification(body: Record<string, unknown>, cfg?: TbankConfig | null): Promise<void> {
  const orderId = typeof body.OrderId === "string" ? body.OrderId : "";

  if (orderId) {
    // Ordinary ride payment: correlate by our OrderId. Checked first because a
    // ride order id and a card-binding order id never collide (distinct
    // prefixes / distinct tables), and a paid ride is the time-critical action.
    const order = await storage.getRidePaymentOrder(orderId);
    if (order) {
      await handleRidePaymentNotification(order, body);
      return;
    }

    // Init binding path: correlate by our OrderId. A matching card_binding row
    // means this is a verification payment, not a ride/topup payment.
    const byOrder = await storage.findCardMethodByOrderId(orderId);
    if (byOrder && byOrder.purpose === "card_binding") {
      await handleInitBindingNotification(byOrder, body, cfg);
      return;
    }

    // SBP account binding via OrderId (some notifications echo our OrderId). A
    // matching sbp_binding row means this notification carries the AccountToken
    // for a pending SBP account binding.
    if (byOrder && byOrder.purpose === "sbp_binding") {
      await handleSbpBindingNotification(byOrder, body);
      return;
    }
  }

  // SBP account binding via RequestKey. The AddAccountQr notification carries a
  // RequestKey (and the AccountToken once authorised) but not necessarily our
  // OrderId, so correlate the pending sbp_binding row by its RequestKey.
  const requestKey = typeof body.RequestKey === "string" ? body.RequestKey : "";
  if (requestKey) {
    const byRequestKey = await storage.findMethodByRequestKey(requestKey);
    if (byRequestKey && byRequestKey.purpose === "sbp_binding") {
      await handleSbpBindingNotification(byRequestKey, body);
      return;
    }
  }

  await handleAddCardNotification(body);
}

// Resolve an SBP account binding (AddAccountQr) from a notification. Activates
// the method only when an AccountToken is present alongside ACTIVE — the token
// is the recurring credential we need for future ChargeQr charges (SBP's
// analogue of a card RebillId). Persists the AccountToken and any acquirer error
// fields (never a secret). Idempotent: a duplicate notification for an already
// active method is ignored.
export async function handleSbpBindingNotification(
  method: PaymentMethod,
  body: Record<string, unknown>,
): Promise<void> {
  if (method.status === "active") return; // already resolved

  const status = typeof body.Status === "string" ? body.Status : "";
  const accountToken = typeof body.AccountToken === "string" ? body.AccountToken : "";
  const bankName = typeof body.BankMemberName === "string" ? body.BankMemberName.trim() : "";
  const success = body.Success === false ? false : undefined;

  const outcome = classifyAccountBinding({ status, accountToken, success });
  if (outcome === "active") {
    await storage.updatePaymentMethod(method.id, {
      status: "active",
      accountToken: accountToken || method.accountToken,
      label: bankName ? `СБП · ${bankName}` : "СБП",
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorDetails: null,
    });
  } else if (outcome === "failed") {
    await storage.updatePaymentMethod(method.id, {
      status: "failed",
      ...bindingErrorPatch(body),
    });
  }
  // Otherwise an intermediate state (NEW/PROCESSING) — leave pending; a later
  // notification (ACTIVE with AccountToken) or the refresh poll will resolve it.
}

// Resolve an ordinary ride-payment order from a notification. On the first
// AUTHORIZED/CONFIRMED we start the ride (idempotently — a duplicate
// notification re-uses the already-started ride and never double-charges or
// double-starts) and record the rideId. On an explicit rejection we mark the
// order failed and leave the bike available. Intermediate states stay pending.
export async function handleRidePaymentNotification(
  order: PaymentOrder,
  body: Record<string, unknown>,
): Promise<void> {
  if (order.status === "paid") return; // already resolved — idempotent

  const status = typeof body.Status === "string" ? body.Status : "";
  const paymentId = body.PaymentId != null ? String(body.PaymentId) : "";
  const success = body.Success === false ? false : undefined;
  const outcome = classifyRidePayment({ status, success });

  if (outcome === "paid") {
    // Start (or reuse) the ride via the shared guarded helper — a racing or
    // duplicate notification cannot create a second ride. On a ride-start
    // failure the helper already marks the order paid with the reason; the
    // webhook just acks (no client to notify here).
    await startRideForPaidOrder(order, paymentId);
    sendToUserAsync(order.userId, {
      title: "Поездка началась",
      body: `Велосипед ${order.bikeId} — тариф ${order.tariffId.toUpperCase()}. Счастливого пути!`,
      url: "/",
      tag: `ride:${order.orderId}`,
      data: { kind: "ride-start", orderId: order.orderId },
    });
  } else if (outcome === "failed") {
    await storage.updateRidePaymentOrder(order.id, {
      status: "failed",
      paymentId: paymentId || order.paymentId,
      ...bindingErrorPatch(body),
    });
    sendToUserAsync(order.userId, {
      title: "Оплата отклонена",
      body: "Не удалось списать средства за поездку. Проверьте карту и попробуйте ещё раз.",
      url: "/payment-methods",
      tag: `ride:${order.orderId}`,
      data: { kind: "ride-payment-failed", orderId: order.orderId },
    });
  }
  // Otherwise an intermediate state — leave pending; a later CONFIRMED resolves it.
}

// Resolve an Init verification-payment binding from a notification. Activates
// the method only when a RebillId is present alongside AUTHORIZED/CONFIRMED —
// the RebillId is the recurring token we need for future charges. Persists the
// PaymentId/RebillId and any acquirer error fields (never a secret).
export async function handleInitBindingNotification(
  method: PaymentMethod,
  body: Record<string, unknown>,
  cfg?: TbankConfig | null,
): Promise<void> {
  if (method.status === "active") return; // already resolved

  const status = typeof body.Status === "string" ? body.Status : "";
  const rebillId = body.RebillId != null ? String(body.RebillId) : "";
  const cardId = typeof body.CardId === "string" ? body.CardId : "";
  const pan = typeof body.Pan === "string" ? body.Pan : "";
  const paymentId = body.PaymentId != null ? String(body.PaymentId) : "";
  const success = body.Success === false ? false : undefined;

  const outcome = classifyInitBinding({ status, rebillId, success });
  if (outcome === "active") {
    await storage.updatePaymentMethod(method.id, {
      status: "active",
      rebillId: rebillId || method.rebillId,
      cardId: cardId || method.cardId,
      paymentId: paymentId || method.paymentId,
      label: pan ? maskPan(pan) : "Карта",
      brand: pan ? cardBrand(pan) ?? method.brand : method.brand,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorDetails: null,
    });
    // Reverse/refund the 1 ₽ verification charge and record the outcome so a
    // stuck rouble is observable (refundStatus/refundError). We pass the fresh
    // notification status so the helper need not re-query GetState.
    const effectivePaymentId = paymentId || method.paymentId;
    if (cfg && effectivePaymentId) {
      const customer = await storage.getUser(method.userId);
      await refundVerificationCharge(cfg, {
        methodId: method.id,
        paymentId: effectivePaymentId,
        knownStatus: status,
        amountKopecks: method.amountKopecks ?? cfg.cardBindAmountKopecks,
        customerEmail: customer?.email,
        customerPhone: customer?.phone,
      });
    }
  } else if (outcome === "failed") {
    await storage.updatePaymentMethod(method.id, {
      status: "failed",
      paymentId: paymentId || method.paymentId,
      ...bindingErrorPatch(body),
    });
  }
  // Otherwise an intermediate state — leave pending; a later notification
  // (CONFIRMED with RebillId) will activate it.
}

// Resolve an AddCard binding (fallback path) from a notification keyed by
// CustomerKey. Unchanged from the original AddCard-only behavior, EXCEPT that
// the no-match branches now log a warning instead of returning silently, since
// this is the terminal fallback of handleTbankNotification's dispatch chain: if
// we reach here and still can't correlate anything, the notification is
// genuinely unmatched. It is still signature-verified (checked by the HTTP
// route before handleTbankNotification is ever called), so we simply
// acknowledge it (the caller answers T-Bank "OK") and log for visibility. We
// deliberately do NOT cancel/refund the underlying payment here — an unmatched
// OrderId/CustomerKey is expected for notifications T-Bank's OWN test/dashboard
// tooling sends directly to our NotificationURL (bypassing our endpoints
// entirely), and refunding a validly-signed payment we simply have no local row
// for would incorrectly reverse money we have no real reason to distrust.
export async function handleAddCardNotification(body: Record<string, unknown>): Promise<void> {
  const status = typeof body.Status === "string" ? body.Status : "";
  const customerKey = typeof body.CustomerKey === "string" ? body.CustomerKey : "";
  const cardId = typeof body.CardId === "string" ? body.CardId : "";
  const rebillId = body.RebillId != null ? String(body.RebillId) : "";
  const pan = typeof body.Pan === "string" ? body.Pan : "";
  const paymentId = body.PaymentId != null ? String(body.PaymentId) : "";
  const orderId = typeof body.OrderId === "string" ? body.OrderId : "";
  // T-Bank may signal failure via Success=false even without a terminal Status.
  const success = body.Success === false ? false : undefined;

  if (!customerKey) {
    log(
      `[tbank] WARN notification unmatched: no CustomerKey (OrderId=${orderId || "-"} ` +
        `PaymentId=${paymentId || "-"} Status=${status || "-"}). Acknowledging without action — ` +
        `likely T-Bank's own test-dashboard traffic or a stale order; NOT cancelling/refunding a ` +
        `validly-signed payment just because it has no local match.`,
      "tbank",
    );
    return;
  }
  const pending = await storage.findPendingCardMethod(customerKey);
  if (!pending) {
    log(
      `[tbank] WARN notification unmatched: CustomerKey=${customerKey} has no pending card method ` +
        `(OrderId=${orderId || "-"} PaymentId=${paymentId || "-"} Status=${status || "-"}). ` +
        `Acknowledging without action — likely T-Bank's own test-dashboard traffic or a stale order; ` +
        `NOT cancelling/refunding a validly-signed payment just because it has no local match.`,
      "tbank",
    );
    return;
  }

  const outcome = classifyCardBinding({ status, cardId });
  if (outcome === "active") {
    await storage.updatePaymentMethod(pending.id, {
      status: "active",
      cardId: cardId || pending.cardId,
      rebillId: rebillId || pending.rebillId,
      label: pan ? maskPan(pan) : "Карта",
      brand: pan ? cardBrand(pan) ?? pending.brand : pending.brand,
      // AddCard binds with no charge — nothing to refund.
      refundStatus: "none",
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorDetails: null,
    });
  } else if (outcome === "failed" || success === false) {
    // An explicit rejection (or Success=false) ends the binding. Persist the
    // acquirer's error fields so the rider/support can see *why* — never a
    // secret, these come straight from T-Bank.
    await storage.updatePaymentMethod(pending.id, {
      status: "failed",
      ...bindingErrorPatch(body),
    });
  }
  // Otherwise an intermediate state — leave the method pending; the rider can
  // refresh it explicitly or the next notification will resolve it.
}

// Extract T-Bank's error fields from a notification/state response into the
// payment_methods error columns. Acquirer-produced, non-secret values only.
export function bindingErrorPatch(body: {
  ErrorCode?: unknown;
  Message?: unknown;
  Details?: unknown;
}): Pick<PaymentMethod, "lastErrorCode" | "lastErrorMessage" | "lastErrorDetails"> {
  const str = (v: unknown) => {
    const s = typeof v === "string" ? v.trim() : v != null ? String(v) : "";
    return s && s !== "0" ? s : null;
  };
  return {
    lastErrorCode: str(body.ErrorCode),
    lastErrorMessage: str(body.Message),
    lastErrorDetails: str(body.Details),
  };
}

// Reverse/refund the 1 rouble verification charge for a just-activated card
// method and PERSIST the outcome so a stuck 1 rouble is observable (refundStatus
// / refundError on the row) instead of vanishing into logs. Fire-and-forget from
// the caller's perspective (never blocks activation), but unlike the old
// tbankCancel it records whether the money actually came back. `knownStatus` is
// the fresh payment status from the same notification/GetState, letting the
// helper skip a redundant GetState round-trip.
//
// CONCURRENCY GUARD: this function has two independent call sites that can
// observe the SAME method transitioning to "active" at nearly the same time —
// handleInitBindingNotification() (the webhook) and the GET
// /api/payments/tbank/refresh-bind/:id polling route (hit every ~2s by more
// than one concurrent client-side poll loop while the bind modal is open, see
// client/src/pages/PaymentMethodsPage.tsx). Before this guard, both callers
// would unconditionally proceed to call tbankRefundVerificationCharge (which
// itself retries /Cancel up to 3 times), so a single PaymentId could get two
// overlapping 3-attempt /Cancel retry loops fired against T-Bank concurrently
// — this reproduces the interleaved "attempt 1 failed / OK / attempt 2 failed
// / attempt 3 failed / GIVE UP" log pattern seen for a single PaymentId in
// production. storage.claimRefund() is an atomic compare-and-swap: only the
// first caller to observe a claimable refundStatus (not already
// "pending"/"refunded") gets to proceed; every later concurrent caller backs
// off immediately with no acquirer call at all.
export async function refundVerificationCharge(
  cfg: TbankConfig,
  input: {
    methodId: number;
    paymentId: string;
    knownStatus?: string;
    amountKopecks: number;
    customerEmail?: string | null;
    customerPhone?: string | null;
  },
): Promise<void> {
  // Atomically claim the right to refund this method. If another concurrent
  // caller already claimed it (or it was already refunded), back off — do NOT
  // call T-Bank a second time for the same charge.
  const claimed = await storage.claimRefund(input.methodId);
  if (!claimed) {
    log(
      `[tbank] refund SKIP methodId=${input.methodId} PaymentId=${input.paymentId}: already claimed by a concurrent ` +
        `caller (webhook/poll race) — not calling /Cancel twice for the same charge.`,
      "tbank",
    );
    return;
  }
  void tbankRefundVerificationCharge(cfg, {
    paymentId: input.paymentId,
    knownStatus: input.knownStatus,
    amountKopecks: input.amountKopecks,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
  })
    .then(async (outcome) => {
      if (outcome.result === "failed") {
        await storage.updatePaymentMethod(input.methodId, {
          refundStatus: "failed",
          refundError: outcome.reason,
        });
      } else {
        // "refunded" (reversal or real refund) or "nothing_to_cancel" (already
        // settled/reversed) — either way no money is outstanding.
        await storage.updatePaymentMethod(input.methodId, {
          refundStatus: "refunded",
          refundError: null,
        });
      }
    })
    .catch(async (err) => {
      await storage.updatePaymentMethod(input.methodId, {
        refundStatus: "failed",
        refundError: String(err?.message ?? "неизвестная ошибка возврата"),
      });
    });
}

// Bind a card via the Init+Recurrent 1 ₽ verification-payment path and write the
// JSON response. Shared by the /bind-card-payment route AND the AddCard fallback
// (when a terminal can't bind without a payment), so both paths behave
// identically — including the hardened reversal/refund of the 1 ₽ once the
// binding is confirmed. Sends a 502 with the acquirer's reason on failure.
export async function bindViaVerificationPayment(
  cfg: TbankConfig,
  userId: string,
  res: Response,
  customerEmail?: string | null,
  customerPhone?: string | null,
): Promise<void> {
  // Unique per attempt so each binding payment correlates to exactly one row.
  // Must stay <= 50 chars or T-Bank rejects Init with code 212 (a UUID user id
  // is 36 chars, so embedding it whole would overflow the limit).
  const orderId = generateBindOrderId();
  const amountKopecks = cfg.cardBindAmountKopecks;

  try {
    const resp = await tbankInitBindCard(cfg, {
      orderId,
      amountKopecks,
      customerKey: userId,
      description: "Проверочный платёж для привязки карты",
      customerEmail,
      customerPhone,
      // ?from=tbank marks the return leg so the client can rewrite history and
      // avoid the Back-button loop into T-Bank's hosted form.
      successUrl: `${cfg.publicAppUrl}/payment-methods?from=tbank`,
      failUrl: `${cfg.publicAppUrl}/payment-methods?from=tbank`,
      notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
    });
    if (!resp.Success || !resp.PaymentURL) {
      res.status(502).json(tbankErrorBody(resp));
      return;
    }
    const method = await storage.createPendingBindPayment({
      userId,
      customerKey: userId,
      orderId,
      amountKopecks,
    });
    await storage.updatePaymentMethod(method.id, {
      paymentId: resp.PaymentId != null ? String(resp.PaymentId) : null,
      paymentUrl: resp.PaymentURL,
      // Keep refundStatus NULL until activation. claimRefund() is the sole,
      // atomic transition to "pending" when it has claimed this charge for
      // reversal/refund; setting it earlier would make that claim fail.
    });
    res.json({ paymentUrl: resp.PaymentURL, amountKopecks, method: "payment", methodId: method.id });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Не удалось привязать карту. Попробуйте позже." });
  }
}

// Build a masked PAN label from a T-Bank-provided masked pan. T-Bank already
// sends a masked value (e.g. "430000******0777"); we render the last 4 digits.
export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return last4 ? `•••• ${last4}` : "Карта";
}

// Derive the payment system from the card's BIN. T-Bank sends a masked PAN whose
// leading 6 digits (the BIN) are visible (e.g. "430000******0777"), which is
// enough to classify the network. Returns null when the BIN doesn't match a
// known range so the client falls back to a generic card icon. Ranges:
//   Visa        4xxxxx
//   Mastercard  51–55, 2221–2720
//   МИР (Mir)   2200–2204
export function cardBrand(pan: string): "visa" | "mastercard" | "mir" | null {
  const digits = pan.replace(/\D/g, "");
  if (digits.length < 4) return null;
  const d4 = Number(digits.slice(0, 4));
  if (digits[0] === "4") return "visa";
  if (d4 >= 2200 && d4 <= 2204) return "mir";
  const d2 = Number(digits.slice(0, 2));
  if (d2 >= 51 && d2 <= 55) return "mastercard";
  if (d4 >= 2221 && d4 <= 2720) return "mastercard";
  return null;
}

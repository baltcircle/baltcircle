import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { z } from "zod";
import { TARIFFS, tariffPriceKopecks } from "@shared/geo";
import {
  insertMapObjectSchema, otpStartSchema, otpVerifySchema, updateProfileSchema,
  adminSetRoleSchema, adminSetBlockedSchema,
  phoneChangeStartSchema, phoneChangeVerifySchema,
  linkPaymentMethodSchema, createSupportTicketSchema, rideInitPaymentSchema,
  rideChargeSavedCardSchema, walletTopupInitSchema,
  adminCreateBikeSchema, adminUpdateBikeSchema,
  createTicketSchema, updateTicketSchema, addTicketCommentSchema,
  adminCreateParkingSchema, adminUpdateParkingSchema, updateMapObjectSchema,
} from "@shared/schema";
import type { PaymentMethod, PaymentOrder, Ride } from "@shared/schema";
import { sendOtpSms, getSmsDiagnostics, smsProvider, getSigmaSmsSendingStatus } from "./../sms";
import {
  getTbankConfig, getTbankDiagnostics, isTbankConfigured, tbankAddCard,
  tbankGetAddCardState, classifyCardBinding, classifyInitBinding,
  verifyNotificationToken,
  tbankInitRidePayment, generateRideOrderId, classifyRidePayment,
  tbankInitSavedCardCharge, tbankCharge, generateSavedCardRideOrderId,
  generateWalletTopupOrderId,
  tbankGetState,
  tbankAddAccountQr, tbankGetAddAccountQrState, tbankRemoveCard,
  generateSbpBindOrderId, extractQrPayload, classifyAccountBinding,
} from "./../tbank";
import type { TbankConfig } from "./../tbank";
import {
  startRideForPaidOrder, tbankErrorBody, handleTbankNotification,
  bindingErrorPatch, refundVerificationCharge, bindViaVerificationPayment,
  maskPan, cardBrand, extractLast4FromLabel, terminalBindingFailurePatch,
} from "./../payments/tbank-handlers";
import { log } from "./../index";
import { logger } from "./../logger";
import {
  riderId, isStaffSession, canManageRide, actorName, clientIp,
  requireRole, requireAuth, requireRoleWhenConfigured,
  otpLimiter, paymentLimiter,
} from "./context";

// A state check is on the synchronous request path when a rider returns to the
// payment-methods page or starts another bind. Bound it so an acquirer outage
// cannot tie up an Express worker indefinitely. On a transport/timeout error we
// deliberately fail closed for that one request: a live 3DS session is still
// possible, and creating another one would orphan it. We never use a local
// timestamp as a substitute for the bank's answer.
const BIND_STATE_TIMEOUT_MS = 5_000;
const LIVE_BINDING_STATUSES = new Set([
  "NEW", "FORM_SHOWED", "3DS_CHECKING", "3DS_CHECKED", "AUTHORIZING",
]);

type BindingReconciliation = "active" | "failed" | "in_flight" | "unavailable";

// Audit HIGH #2: /ride/init and /ride/charge-saved-card require a client
// idempotency key so a retried request (double-click, network drop + resend)
// replays the original order/charge instead of creating a second one. Only
// the web client in this repo calls these routes, so the header can be a hard
// requirement rather than an optional best-effort hint.
const IDEMPOTENCY_KEY_MAX_LEN = 100;

function readIdempotencyKey(req: Request): { key: string } | { error: string } {
  const raw = req.get("Idempotency-Key");
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { error: "Отсутствует заголовок Idempotency-Key" };
  if (key.length > IDEMPOTENCY_KEY_MAX_LEN) return { error: "Некорректный Idempotency-Key" };
  return { key };
}

function failedBindingPatch(body: Record<string, unknown>, fallback: string) {
  const patch = bindingErrorPatch(body);
  return {
    ...patch,
    lastErrorCode: patch.lastErrorCode ?? "BINDING_STATE_UNAVAILABLE",
    lastErrorMessage: patch.lastErrorMessage ?? fallback,
    lastErrorDetails: patch.lastErrorDetails ?? null,
  };
}

// T-Bank uses an unsuccessful state request for an identifier it no longer
// knows. That is terminal for our local attempt: it cannot become active later.
// Keep the match deliberately narrow; authentication/terminal outages are
// handled as `unavailable` below and must not incorrectly fail a live bind.
function isUnknownBindingAtBank(resp: Record<string, unknown>): boolean {
  const code = String(resp.ErrorCode ?? "").trim();
  const message = `${String(resp.Message ?? "")} ${String(resp.Details ?? "")}`.toLowerCase();
  return code === "7" || /not\s*found|unknown|не\s*найден|не\s*существует/.test(message);
}

// RequestKey and PaymentId are opaque T-Bank values, so do not impose a
// provider-specific character whitelist here. A trimmed non-control string is
// the smallest safe definition of a usable identifier; blank/control-only
// legacy values cannot name a live bank session and must not fail closed.
function normalizedBindingIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const identifier = value.trim();
  return identifier && !/[\u0000-\u001F\u007F]/.test(identifier) ? identifier : undefined;
}

async function reconcilePendingCardBinding(
  method: PaymentMethod,
  cfg: TbankConfig,
): Promise<BindingReconciliation> {
  if (method.status !== "pending") return method.status === "active" ? "active" : "failed";

  const requestKey = normalizedBindingIdentifier(method.requestKey);
  const paymentId = normalizedBindingIdentifier(method.paymentId);
  const isAddCard = Boolean(requestKey);
  const identifier = requestKey || paymentId;
  if (method.provider !== "tbank" || !identifier) {
    logger.info({
      userId: method.userId,
      methodId: method.id,
      requestKeyPresent: Boolean(requestKey),
      paymentIdPresent: Boolean(paymentId),
      outcome: "failed_missing_identifier",
    }, "[tbank] card-bind reconciliation");
    await storage.updatePaymentMethod(method.id, {
      status: "failed",
      lastErrorCode: "BINDING_IDENTIFIER_MISSING",
      lastErrorMessage: "Не удалось найти идентификатор привязки в платёжном сервисе.",
      lastErrorDetails: null,
    });
    return "failed";
  }

  let resp: Record<string, unknown>;
  try {
    resp = isAddCard
      ? await tbankGetAddCardState(cfg, requestKey!, BIND_STATE_TIMEOUT_MS)
      : await tbankGetState(cfg, paymentId!, BIND_STATE_TIMEOUT_MS);
  } catch (err) {
    logger.warn({
      err,
      userId: method.userId,
      methodId: method.id,
      requestKeyPresent: Boolean(requestKey),
      paymentIdPresent: Boolean(paymentId),
      outcome: "unavailable",
    }, "[tbank] card-bind state check failed");
    return "unavailable";
  }

  // Intentionally record only decision-relevant, non-card data: a raw state
  // response may contain PAN/CardId/RebillId and must never reach application
  // logs.
  logger.info({
    userId: method.userId,
    methodId: method.id,
    requestKeyPresent: Boolean(requestKey),
    paymentIdPresent: Boolean(paymentId),
    bankResponse: {
      success: resp.Success === true,
      status: typeof resp.Status === "string" ? resp.Status : null,
      errorCode: resp.ErrorCode != null ? String(resp.ErrorCode) : null,
    },
  }, "[tbank] card-bind state response");

  if (!resp.Success) {
    if (isUnknownBindingAtBank(resp)) {
      await storage.updatePaymentMethod(method.id, {
        status: "failed",
        ...failedBindingPatch(resp, "Привязка не найдена в платёжном сервисе."),
      });
      return "failed";
    }
    log(`[tbank] binding state query rejected methodId=${method.id} code=${String(resp.ErrorCode ?? "?")}`, "tbank");
    return "unavailable";
  }

  const status = typeof resp.Status === "string" ? resp.Status : "";
  const cardId = typeof resp.CardId === "string" ? resp.CardId : "";
  const rebillId = resp.RebillId != null ? String(resp.RebillId) : "";
  const pan = typeof resp.Pan === "string" ? resp.Pan : "";
  if (LIVE_BINDING_STATUSES.has(status.trim().toUpperCase())) return "in_flight";
  const outcome = isAddCard
    ? classifyCardBinding({ status, cardId })
    : classifyInitBinding({ status, rebillId });

  if (outcome === "failed") {
    await storage.updatePaymentMethod(method.id, {
      status: "failed",
      ...terminalBindingFailurePatch(resp),
    });
    return "failed";
  }

  if (outcome === "active") {
    const label = pan ? maskPan(pan) : method.label === "Карта (привязывается…)" ? "Карта" : method.label;
    const brand = pan ? cardBrand(pan) ?? method.brand : method.brand;
    const last4 = extractLast4FromLabel(label);
    const duplicate = last4
      ? await storage.findActiveCardDuplicate(method.userId, last4, brand, method.id)
      : undefined;
    if (duplicate) {
      await storage.updatePaymentMethod(method.id, {
        status: "failed",
        lastErrorCode: "DUPLICATE_CARD",
        lastErrorMessage: "Эта карта уже привязана к вашему аккаунту.",
        lastErrorDetails: null,
      });
      if (!isAddCard && method.paymentId) {
        const customer = await storage.getUser(method.userId);
        void refundVerificationCharge(cfg, {
          methodId: method.id,
          paymentId: method.paymentId,
          knownStatus: status,
          amountKopecks: method.amountKopecks ?? cfg.cardBindAmountKopecks,
          customerEmail: customer?.email,
          customerPhone: customer?.phone,
        });
      }
      return "failed";
    }

    await storage.updatePaymentMethod(method.id, {
      status: "active",
      cardId: cardId || method.cardId,
      rebillId: rebillId || method.rebillId,
      paymentId: method.paymentId,
      label,
      brand,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorDetails: null,
    });
    if (!isAddCard && method.paymentId) {
      const customer = await storage.getUser(method.userId);
      void refundVerificationCharge(cfg, {
        methodId: method.id,
        paymentId: method.paymentId,
        knownStatus: status,
        amountKopecks: method.amountKopecks ?? cfg.cardBindAmountKopecks,
        customerEmail: customer?.email,
        customerPhone: customer?.phone,
      });
    }
    return "active";
  }

  // NEW, FORM_SHOWED, 3DS_* and AUTHORIZING are an actual acquirer-side
  // session, not a locally guessed "fresh" row. AUTHORIZED deliberately goes
  // through the binding-specific classifier first: an Init+Recurrent response
  // may already include its usable RebillId at that status.
  return "in_flight";
}

async function reconcilePendingCardBindingsForUser(
  userId: string,
  cfg: TbankConfig,
  methods?: PaymentMethod[],
): Promise<BindingReconciliation[]> {
  // This is intentionally the single user-level reconciliation path. Listing
  // methods, starting a new binding, and explicit refreshes must all ask the
  // same T-Bank endpoint for every pending card instead of letting a duplicate
  // "pending" query drift back into one of the entry points.
  const pending = (methods ?? await storage.listPaymentMethods(userId))
    .filter((method) => method.type === "card" && method.status === "pending");
  return Promise.all(pending.map(async (method) => {
    // A legacy row or a transient failure while resolving one row must not
    // prevent later rows for this same user from being independently resolved.
    // We still fail closed for the affected row only, because its bank session
    // may be live.
    try {
      return await reconcilePendingCardBinding(method, cfg);
    } catch (err) {
      logger.warn({
        err,
        userId,
        methodId: method.id,
        requestKeyPresent: Boolean(normalizedBindingIdentifier(method.requestKey)),
        paymentIdPresent: Boolean(normalizedBindingIdentifier(method.paymentId)),
        outcome: "unavailable",
      }, "[tbank] card-bind reconciliation row failed");
      return "unavailable" as const;
    }
  }));
}

// Starting another card-bind flow is an explicit product-level abandonment of
// every previous unfinished flow. The hosted T-Bank form may still be open in
// another tab, but the application cannot observe that reliably and must never
// leave the rider blocked behind it. Mark the old rows terminal locally before
// creating the next bank session. A later bank-confirmed success is still
// accepted by the webhook handler through its stable OrderId/RequestKey
// correlation, so supersession does not discard a successfully bound card.
async function supersedePendingCardBindingsForUser(userId: string): Promise<void> {
  const methods = await storage.listPaymentMethods(userId);
  const pending = methods.filter((method) => method.type === "card" && method.status === "pending");
  if (!pending.length) return;

  await Promise.all(pending.map((method) => storage.updatePaymentMethod(method.id, {
    status: "failed",
    lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    lastErrorMessage: "Привязка отменена: начата новая попытка.",
    lastErrorDetails: null,
  })));
  logger.info({
    userId,
    supersededRows: pending.map((method) => ({
      methodId: method.id,
      requestKeyPresent: Boolean(normalizedBindingIdentifier(method.requestKey)),
      paymentIdPresent: Boolean(normalizedBindingIdentifier(method.paymentId)),
    })),
  }, "[tbank] card-bind attempts superseded");
}

export function registerPaymentRoutes(app: Express): void {
  // -------------- Payment methods (MVP metadata only) --------------
  // Per-user linked payment methods. No card numbers / CVC are ever accepted or
  // stored — only the method kind, a masked label, and a status. No real
  // acquiring is performed.
  app.get("/api/payment-methods", requireAuth, async (req, res) => {
    const userId = riderId(req);
    const methods = await storage.listPaymentMethods(userId);
    const cfg = getTbankConfig();
    if (!cfg) return res.json(methods);

    // A page visit is a return from the hosted form just as much as a webhook
    // is. Resolve every pending card before returning the list, so abandoned
    // rows cannot become a durable UI/database state.
    await reconcilePendingCardBindingsForUser(userId, cfg, methods);
    res.json(await storage.listPaymentMethods(userId));
  });
  app.post("/api/payment-methods", requireAuth, async (req, res) => {
    const parsed = linkPaymentMethodSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.status(201).json(await storage.linkPaymentMethod(riderId(req), parsed.data.type));
  });
  app.delete("/api/payment-methods/:id", requireAuth, async (req, res) => {
    const userId = riderId(req);
    const method = await storage.getPaymentMethod(Number(req.params.id));
    if (!method || method.userId !== userId) {
      return res.status(404).json({ error: "Способ оплаты не найден" });
    }
    // The client uses this same path as a three-minute safety check. Reconcile
    // first so a webhook/poll which has just resolved the method to active or
    // failed wins over stale client data. A row that is STILL pending is an
    // explicit cancellation: hard-delete the local lock even if T-Bank reports
    // a live form/3DS session. Otherwise DELETE would return 200 while leaving
    // the exact pending row that the next bind guard blocks on.
    if (req.query?.pendingOnly === "1" && method.status !== "pending") {
      return res.json({ ok: true, cancelled: false });
    }
    if (req.query?.pendingOnly === "1" && method.status === "pending"
      && method.type === "card" && method.provider === "tbank") {
      const cfg = getTbankConfig();
      if (cfg) await reconcilePendingCardBinding(method, cfg);

      // Re-read after reconciliation: do not remove a card which was just
      // activated/failed, but do remove a row still pending (including NEW).
      // `unlinkPaymentMethod` is a completed hard delete before its promise
      // resolves; handlers only update correlated existing rows and never
      // recreate one, so a delayed T-Bank notification cannot resurrect it.
      const current = await storage.getPaymentMethod(method.id);
      if (!current) return res.json({ ok: true, cancelled: true });
      if (current.status !== "pending") return res.json({ ok: true, cancelled: false });

      const result = await unlinkPaymentMethodForUser(userId, current, clientIp(req));
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.json({ ok: true, cancelled: true });
    }
    const result = await unlinkPaymentMethodForUser(userId, method, clientIp(req));
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json(req.query?.pendingOnly === "1" ? { ok: true, cancelled: true } : { ok: true });
  });

  // -------------- T-Bank / T-Kassa real payments --------------
  // Stage 1: card binding (AddCard) and ride-payment creation (Init). Card data
  // is entered only on T-Bank's hosted PaymentURL — never on our side. When the
  // terminal credentials are not configured these endpoints answer 503 with a
  // clear message so the app degrades gracefully instead of crashing.

  // Public config probe so the client can show "Платежи настраиваются" instead
  // of offering a flow that will 503. Never exposes the password/terminal key.
  app.get("/api/payments/tbank/config", async (_req, res) => {
    res.json({ configured: isTbankConfigured() });
  });

  // Admin-only diagnostics to confirm the terminal credentials are wired up
  // correctly. Returns ONLY non-secret metadata (lengths, last-4 of the terminal
  // key, a passwordHasDollar flag) — never the password or full terminal key. A
  // password whose leading `$` was stripped by shell/compose interpolation shows
  // up as an unexpectedly short passwordLength or passwordHasDollar=false here.
  app.get("/api/payments/tbank/diagnostics", requireRole("admin"), async (_req, res) => {
    res.json(getTbankDiagnostics());
  });

  // Start a card binding for the current registered rider. Calls AddCard with
  // CustomerKey = user.id and returns the PaymentURL the client opens. A pending
  // payment-method row is created so the UI can show "привязывается…" until the
  // notification confirms it.
  app.post("/api/payments/tbank/add-card", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    await supersedePendingCardBindingsForUser(user.id);

    try {
      const resp = await tbankAddCard(cfg, { customerKey: user.id });
      if (!resp.Success || !resp.PaymentURL) {
        // AddCard rejected (some terminals don't support card binding without a
        // payment). Transparently FALL BACK to the Init+Recurrent 1 ₽ path so the
        // rider still gets a working binding — with the hardened refund.
        log(`[tbank] AddCard unavailable (${resp.ErrorCode ?? "?"}: ${resp.Message ?? "?"}), falling back to 1 ₽ verification payment`, "tbank");
        return void (await bindViaVerificationPayment(cfg, user.id, res, user.email, user.phone));
      }
      // AddCard binds with NO charge — there is nothing to refund.
      const method = await storage.createPendingCardMethod({
        userId: user.id,
        customerKey: user.id,
        requestKey: typeof resp.RequestKey === "string" ? resp.RequestKey : undefined,
      });
      await storage.updatePaymentMethod(method.id, { refundStatus: "none" });
      res.json({ paymentUrl: resp.PaymentURL, method: "addcard" });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось привязать карту. Попробуйте позже." });
    }
  });

  // Start a card binding via a small verification PAYMENT (Init + Recurrent=Y).
  // This is the PRIMARY binding path: AddCard rejects cards on some test/sandbox
  // terminals, whereas a real (tiny) payment with Recurrent=Y reliably yields a
  // RebillId we can use for future recurring charges. The rider pays e.g. 1 ₽ on
  // T-Bank's hosted form (PAN/CVC never reach us); on CONFIRMED/AUTHORIZED with a
  // RebillId the notification webhook activates the method. Returns the
  // PaymentURL the client opens. A pending payment-method row (purpose=
  // card_binding) is created so the UI can show "привязывается…".
  app.post("/api/payments/tbank/bind-card-payment", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    await supersedePendingCardBindingsForUser(user.id);

    await bindViaVerificationPayment(cfg, user.id, res, user.email, user.phone);
  });

  // Unified card-binding entry point the client uses. Picks the method from
  // config (TBANK_CARD_BIND_METHOD): "addcard" tries a no-charge AddCard binding
  // first (and auto-falls-back to the 1 ₽ payment if the terminal rejects it);
  // "payment" (default) goes straight to the 1 ₽ verification payment. Swapping
  // the strategy is an env change, not a code change.
  app.post("/api/payments/tbank/bind-card", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    // A new click explicitly supersedes every unfinished card-bind flow instead
    // of returning 409. This is deliberately not time-based: the next attempt
    // is usable immediately even while T-Bank still reports the old session NEW.
    await supersedePendingCardBindingsForUser(user.id);

    if (cfg.cardBindMethod === "addcard") {
      // No-charge AddCard, with automatic fallback to the 1 ₽ payment inside the
      // route handler when the terminal doesn't support charge-free binding.
      try {
        const resp = await tbankAddCard(cfg, { customerKey: user.id });
        if (!resp.Success || !resp.PaymentURL) {
          log(`[tbank] AddCard unavailable (${resp.ErrorCode ?? "?"}: ${resp.Message ?? "?"}), falling back to 1 ₽ verification payment`, "tbank");
          return void (await bindViaVerificationPayment(cfg, user.id, res, user.email, user.phone));
        }
        const method = await storage.createPendingCardMethod({
          userId: user.id,
          customerKey: user.id,
          requestKey: typeof resp.RequestKey === "string" ? resp.RequestKey : undefined,
        });
        await storage.updatePaymentMethod(method.id, { refundStatus: "none" });
        return res.json({ paymentUrl: resp.PaymentURL, method: "addcard", methodId: method.id });
      } catch (err: any) {
        return res.status(502).json({ error: err?.message ?? "Не удалось привязать карту. Попробуйте позже." });
      }
    }
    // Default: 1 ₽ verification payment (RebillId-guaranteed on all terminals).
    await bindViaVerificationPayment(cfg, user.id, res, user.email, user.phone);
  });

  // Start an SBP ACCOUNT binding via AddAccountQr. Unlike a card, the rider binds
  // their bank account once and future ride tariffs are charged via ChargeQr with
  // the returned AccountToken (SBP's analogue of a card RebillId). AddAccountQr
  // returns a RequestKey (to poll/correlate) and a Data payload the rider opens
  // in their bank app to authorise the binding. The AccountToken itself arrives
  // asynchronously (notification webhook, or the refresh poll below). We create a
  // pending sbp-type row (purpose=sbp_binding) keyed by the RequestKey so both
  // resolution paths can find it. No account data ever reaches us. If the
  // SBP-recurrent product isn't activated on the terminal, T-Bank answers
  // Success=false and we surface its reason (502) rather than crashing.
  app.post("/api/payments/tbank/bind-sbp", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    // Correlates this binding to exactly one pending row; <= 50 chars.
    const orderId = generateSbpBindOrderId();

    try {
      const resp = await tbankAddAccountQr(cfg, {
        customerKey: user.id,
        description: "Привязка счёта СБП для оплаты поездок",
        dataType: "PAYLOAD",
      });
      // Success=false covers the "product not activated on terminal" case: we
      // relay the acquirer's own message so the UI explains it, no crash.
      if (!resp.Success) {
        return res.status(502).json(tbankErrorBody(resp));
      }
      const qrPayload = extractQrPayload(resp);
      if (!qrPayload) {
        return res.status(502).json({
          error: "Платёжный сервис не вернул данные для QR. Попробуйте позже.",
        });
      }
      const method = await storage.createPendingSbpBinding({
        userId: user.id,
        customerKey: user.id,
        orderId,
        requestKey: typeof resp.RequestKey === "string" ? resp.RequestKey : undefined,
      });
      res.json({
        methodId: method.id,
        requestKey: typeof resp.RequestKey === "string" ? resp.RequestKey : null,
        qrPayload,
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось привязать счёт СБП. Попробуйте позже." });
    }
  });

  // Refresh a pending SBP account binding by polling GetAddAccountQrState. This
  // is the recovery path when the notification webhook never arrives (or the
  // rider closed the tab before it landed), leaving the method "pending". The
  // poll signs ONLY RequestKey (see tbankGetAddAccountQrState); on ACTIVE with an
  // AccountToken we activate the method and persist the opaque token used by
  // future ChargeQr; on INACTIVE we mark it failed. The rider can refresh only
  // their OWN method; staff may refresh any. Returns the updated method.
  app.get("/api/payments/tbank/refresh-bind-sbp/:paymentMethodId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });

    const method = await storage.getPaymentMethod(Number(req.params.paymentMethodId));
    if (!method) return res.status(404).json({ error: "Способ оплаты не найден" });

    const actor = await storage.getUser(userId);
    const isStaff = actor?.role === "admin" || actor?.role === "operator";
    if (method.userId !== userId && !isStaff) {
      return res.status(404).json({ error: "Способ оплаты не найден" });
    }

    if (method.provider !== "tbank" || method.type !== "sbp" || !method.requestKey) {
      return res.status(400).json({ error: "Для этого способа оплаты проверка статуса недоступна." });
    }
    if (method.status === "active") {
      return res.json(method); // already resolved; nothing to poll
    }

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    let resp;
    try {
      resp = await tbankGetAddAccountQrState(cfg, method.requestKey);
    } catch (err: any) {
      return res.status(502).json({ error: err?.message ?? "Не удалось проверить статус. Попробуйте позже." });
    }

    if (!resp.Success) {
      // The poll itself was rejected (bad RequestKey, etc.). Surface the
      // acquirer's reason but do NOT mark the method failed — only our query
      // failed, the binding state is unknown.
      return res.status(502).json(tbankErrorBody(resp));
    }

    const status = typeof resp.Status === "string" ? resp.Status : "";
    const accountToken = typeof resp.AccountToken === "string" ? resp.AccountToken : "";
    const bankName = typeof resp.BankMemberName === "string" ? resp.BankMemberName.trim() : "";
    const outcome = classifyAccountBinding({ status, accountToken });

    if (outcome === "active") {
      const updated = await storage.updatePaymentMethod(method.id, {
        status: "active",
        accountToken: accountToken || method.accountToken,
        label: bankName ? `СБП · ${bankName}` : "СБП",
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorDetails: null,
      });
      return res.json(updated);
    }
    if (outcome === "failed") {
      const updated = await storage.updatePaymentMethod(method.id, {
        status: "failed",
        ...bindingErrorPatch(resp),
      });
      return res.json(updated);
    }
    // Still pending — report the row unchanged. Although SBP does not take
    // part in the card-binding guard, status polling should not manufacture a
    // lifecycle update when the acquirer has reported no transition.
    return res.json(method);
  });

  // Start a ride by paying its tariff up front via an ordinary T-Bank payment
  // (NO saved card / RebillId required — this is the working MVP payment path).
  // The rider pays the chosen tariff on T-Bank's hosted form; the ride is only
  // started once the notification webhook confirms the payment. We validate the
  // bike is rentable and the tariff is known, resolve the price authoritatively
  // server-side (never trusting a client amount), create a pending payment order
  // and return the PaymentURL the client opens. No card data ever reaches us.
  app.post("/api/payments/tbank/ride/init", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (user.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }

    const idem = readIdempotencyKey(req);
    if ("error" in idem) return res.status(400).json({ error: idem.error });

    const parsed = rideInitPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }

    // Idempotency check BEFORE any bike/tariff/T-Bank work (audit HIGH #2): a
    // retried request with the SAME key replays the original order exactly,
    // even if the bike meanwhile became unavailable to a fresh request.
    const existingByKey = await storage.getRidePaymentOrderByIdempotencyKey(userId, idem.key);
    if (existingByKey) {
      return res.json({
        orderId: existingByKey.orderId,
        paymentUrl: existingByKey.paymentUrl,
        amountKopecks: existingByKey.amountKopecks,
        status: existingByKey.status,
      });
    }

    const bike = await storage.getBike(parsed.data.bikeId);
    if (!bike) return res.status(404).json({ error: "Велосипед не найден" });
    if (bike.status !== "available" && bike.status !== "reserved") {
      return res.status(409).json({ error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` });
    }
    if (await storage.getActiveRide(userId)) {
      return res.status(409).json({ error: "У вас уже есть активная поездка" });
    }

    const tariffDef = TARIFFS.find((t) => t.id === parsed.data.tariffId);
    if (!tariffDef) return res.status(400).json({ error: "Неизвестный тариф" });
    const amountKopecks = Math.round(tariffDef.price * 100);

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    // Unique per attempt and <= 50 chars (T-Bank Init rejects longer with 212).
    const orderId = generateRideOrderId();

    try {
      const resp = await tbankInitRidePayment(cfg, {
        orderId,
        amountKopecks,
        customerKey: user.id,
        description: `Аренда велосипеда ${bike.id} • ${tariffDef.name}`,
        customerEmail: user.email,
        customerPhone: user.phone,
        successUrl: `${cfg.publicAppUrl}/payment-result?orderId=${encodeURIComponent(orderId)}`,
        failUrl: `${cfg.publicAppUrl}/payment-result?orderId=${encodeURIComponent(orderId)}`,
        notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
      });
      if (!resp.Success || !resp.PaymentURL) {
        return res.status(502).json(tbankErrorBody(resp));
      }
      try {
        // createRidePaymentOrder itself absorbs a unique-violation race on
        // (userId, idempotencyKey) and returns the winning row instead of
        // throwing (audit HIGH #2) — T-Bank Init has no financial side effect,
        // so a rare true-concurrency double-Init is harmless waste, not risk.
        const order = await storage.createRidePaymentOrder({
          orderId,
          userId: user.id,
          bikeId: bike.id,
          tariffId: tariffDef.id,
          amountKopecks,
          idempotencyKey: idem.key,
        });
        if (order.orderId !== orderId) {
          // Lost the race: a concurrent identical request already has a row.
          // Replay ITS data rather than updating/overwriting it.
          return res.json({
            orderId: order.orderId,
            paymentUrl: order.paymentUrl,
            amountKopecks: order.amountKopecks,
            status: order.status,
          });
        }
        await storage.updateRidePaymentOrder(order.id, {
          paymentId: resp.PaymentId != null ? String(resp.PaymentId) : null,
          paymentUrl: resp.PaymentURL,
        });
      } catch (dbErr) {
        // The payment was created at T-Bank but we failed to persist the order
        // locally (e.g. a legacy DB missing columns the startup migration should
        // have added). Don't leak the raw SQLite error to the rider.
        log(`[tbank] failed to persist ride payment order: ${(dbErr as Error)?.message ?? "?"}`, "tbank");
        return res.status(500).json({ error: "Не удалось сохранить заказ оплаты. Попробуйте позже." });
      }
      res.json({ orderId, paymentUrl: resp.PaymentURL, amountKopecks, status: "pending" });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось создать оплату. Попробуйте позже." });
    }
  });

  // Start a ride by charging the rider's SAVED card (stored RebillId) for the
  // chosen tariff — the recurring (merchant-initiated) flow, no hosted form. We
  // validate the rider/bike/tariff exactly like ride/init, resolve the price
  // server-side, then run Init + Charge against the saved card's RebillId. On a
  // synchronous CONFIRMED we start the ride immediately and return it. AUTHORIZED
  // is only a held auth (audit HIGH #1) — like any other non-terminal state it
  // leaves the order pending and the notification webhook finishes it once the
  // charge is actually captured. On failure we surface the acquirer's sanitized
  // reason and leave the bike available. No card data is ever touched — only
  // the RebillId token.
  app.post("/api/payments/tbank/ride/charge-saved-card", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (user.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }

    const idem = readIdempotencyKey(req);
    if ("error" in idem) return res.status(400).json({ error: idem.error });

    const parsed = rideChargeSavedCardSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }

    // Idempotency check BEFORE any bike/tariff validation or acquirer call
    // (audit HIGH #2). A retry must NEVER re-run Init+Charge — unlike
    // /ride/init, Charge moves real money, so replay-before-anything-else is
    // mandatory here, not just an optimization.
    const existingByKey = await storage.getRidePaymentOrderByIdempotencyKey(userId, idem.key);
    if (existingByKey) {
      if (existingByKey.status === "paid") {
        return res.json({
          orderId: existingByKey.orderId,
          status: "paid",
          rideId: existingByKey.rideId,
          amountKopecks: existingByKey.amountKopecks,
        });
      }
      if (existingByKey.status === "failed") {
        return res.status(402).json(tbankErrorBody({
          ErrorCode: existingByKey.lastErrorCode ?? undefined,
          Message: existingByKey.lastErrorMessage ?? undefined,
          Details: existingByKey.lastErrorDetails ?? undefined,
        }));
      }
      // "pending": either still resolving (e.g. deferred 3DS) or reserved by a
      // racing sibling that hasn't called Charge yet — either way, do NOT charge
      // again. The client already knows how to poll GET .../ride/:orderId.
      return res.json({ orderId: existingByKey.orderId, status: "pending", amountKopecks: existingByKey.amountKopecks });
    }

    const bike = await storage.getBike(parsed.data.bikeId);
    if (!bike) return res.status(404).json({ error: "Велосипед не найден" });
    if (bike.status !== "available" && bike.status !== "reserved") {
      return res.status(409).json({ error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` });
    }
    if (await storage.getActiveRide(userId)) {
      return res.status(409).json({ error: "У вас уже есть активная поездка" });
    }

    const tariffDef = TARIFFS.find((t) => t.id === parsed.data.tariffId);
    if (!tariffDef) return res.status(400).json({ error: "Неизвестный тариф" });
    const amountKopecks = Math.round(tariffDef.price * 100);

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    // Resolve a usable saved card (active T-Bank method with a RebillId). When
    // none exists the client should fall back to the hosted payment flow.
    const card = await storage.getActiveSavedCard(userId, parsed.data.paymentMethodId);
    if (!card || !card.rebillId) {
      return res.status(409).json({ error: "Нет сохранённой карты для списания. Оплатите другой картой." });
    }

    const orderId = generateSavedCardRideOrderId();

    // Reserve the order row BEFORE touching the acquirer (audit HIGH #2): if a
    // concurrent request with the SAME idempotency key raced us here, exactly
    // one of them wins the DB insert and calls Init+Charge — the loser must
    // return the winner's (still-pending) state instead of charging again.
    let order: PaymentOrder;
    try {
      const reserved = await storage.reserveRidePaymentOrder({
        orderId,
        userId: user.id,
        bikeId: bike.id,
        tariffId: tariffDef.id,
        amountKopecks,
        source: "saved_card",
        paymentMethodId: card.id,
        rebillId: card.rebillId,
        idempotencyKey: idem.key,
      });
      if (!reserved.created) {
        // Lost the race — do not call Init/Charge; report the winner's state.
        const o = reserved.order;
        if (o.status === "paid") {
          return res.json({ orderId: o.orderId, status: "paid", rideId: o.rideId, amountKopecks: o.amountKopecks });
        }
        if (o.status === "failed") {
          return res.status(402).json(tbankErrorBody({
            ErrorCode: o.lastErrorCode ?? undefined,
            Message: o.lastErrorMessage ?? undefined,
            Details: o.lastErrorDetails ?? undefined,
          }));
        }
        return res.json({ orderId: o.orderId, status: "pending", amountKopecks: o.amountKopecks });
      }
      order = reserved.order;
    } catch (dbErr) {
      log(`[tbank] failed to reserve saved-card order: ${(dbErr as Error)?.message ?? "?"}`, "tbank");
      return res.status(500).json({ error: "Не удалось сохранить заказ оплаты. Попробуйте позже." });
    }

    try {
      // Step 1: Init registers the payment object and yields a PaymentId.
      const init = await tbankInitSavedCardCharge(cfg, {
        orderId,
        amountKopecks,
        customerKey: card.customerKey ?? user.id,
        description: `Аренда велосипеда ${bike.id} • ${tariffDef.name}`,
        customerEmail: user.email,
        customerPhone: user.phone,
        notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
      });
      if (!init.Success || init.PaymentId == null) {
        await storage.updateRidePaymentOrder(order.id, { status: "failed", ...bindingErrorPatch(init) });
        return res.status(502).json(tbankErrorBody(init));
      }
      const paymentId = String(init.PaymentId);

      // Persist the PaymentId on the already-reserved order BEFORE charging so a
      // confirming webhook that races our synchronous response can correlate by
      // OrderId.
      try {
        await storage.updateRidePaymentOrder(order.id, { paymentId });
      } catch (dbErr) {
        log(`[tbank] failed to persist saved-card order: ${(dbErr as Error)?.message ?? "?"}`, "tbank");
        return res.status(500).json({ error: "Не удалось сохранить заказ оплаты. Попробуйте позже." });
      }

      // Step 2: Charge debits the saved card using PaymentId + RebillId.
      const charge = await tbankCharge(cfg, { paymentId, rebillId: card.rebillId });
      const status = typeof charge.Status === "string" ? charge.Status : "";
      const outcome = classifyRidePayment({ status, success: charge.Success === false ? false : undefined });

      if (outcome === "paid") {
        // Start the ride now (guarded — a racing webhook cannot double-start).
        // Shared with the webhook path via startRideForPaidOrder().
        const started = await startRideForPaidOrder(order, paymentId);
        if (!started.ok) {
          return res.status(409).json({ error: started.reason });
        }
        return res.json({ orderId, status: "paid", rideId: started.rideId, amountKopecks });
      }

      if (outcome === "failed") {
        await storage.updateRidePaymentOrder(order.id, {
          status: "failed",
          paymentId,
          ...bindingErrorPatch(charge),
        });
        // 402 Payment Required — the charge was declined; bike stays available.
        return res.status(402).json(tbankErrorBody(charge));
      }

      // Deferred (e.g. 3DS step-up). Leave pending; the webhook resolves it and
      // the client polls the status endpoint below.
      return res.json({ orderId, status: "pending", amountKopecks });
    } catch (err: any) {
      return res.status(502).json({ error: err?.message ?? "Не удалось списать оплату. Попробуйте позже." });
    }
  });

  // Status of a ride payment order for the post-redirect result page. The rider
  // may only read their OWN order. Returns the lifecycle status and, once the
  // ride has started, its id so the client can route into the active ride.
  app.get("/api/payments/tbank/ride/:orderId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const order = await storage.getRidePaymentOrder(req.params.orderId);
    if (!order || order.userId !== userId) {
      return res.status(404).json({ error: "Заказ не найден" });
    }
    res.json({
      orderId: order.orderId,
      status: order.status,
      bikeId: order.bikeId,
      tariffId: order.tariffId,
      amountKopecks: order.amountKopecks,
      rideId: order.rideId,
      // Acquirer failure detail (non-secret values only) so the result page can
      // show WHY a payment was declined — code/message/details for debugging
      // test-card issues, plus a short human message in `error` for the headline.
      error: order.lastErrorMessage ?? undefined,
      errorCode: order.lastErrorCode ?? undefined,
      errorMessage: order.lastErrorMessage ?? undefined,
      errorDetails: order.lastErrorDetails ?? undefined,
    });
  });

  // Start a wallet top-up via a real T-Bank charge (audit CRITICAL #1 fix).
  // Replaces the old POST /api/wallet/topup, which credited the wallet
  // straight from a client-supplied amount with NO payment step — any
  // authenticated rider could mint arbitrary balance. The rider pays on
  // T-Bank's hosted form; the balance is only credited once the notification
  // webhook confirms the charge (see handleWalletTopupNotification).
  app.post("/api/payments/tbank/wallet/init", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (user.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }

    const parsed = walletTopupInitSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }

    // amount arrives in roubles (rider-facing unit); everything downstream
    // (order row, T-Bank Init, wallet ledger) works in kopecks.
    const amountKopecks = Math.round(parsed.data.amount * 100);

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    // Unique per attempt and <= 50 chars (T-Bank Init rejects longer with 212).
    const orderId = generateWalletTopupOrderId();

    try {
      const resp = await tbankInitRidePayment(cfg, {
        orderId,
        amountKopecks,
        customerKey: user.id,
        description: "Пополнение баланса TakeRide",
        customerEmail: user.email,
        customerPhone: user.phone,
        successUrl: `${cfg.publicAppUrl}/payment-result?orderId=${encodeURIComponent(orderId)}`,
        failUrl: `${cfg.publicAppUrl}/payment-result?orderId=${encodeURIComponent(orderId)}`,
        notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
      });
      if (!resp.Success || !resp.PaymentURL) {
        return res.status(502).json(tbankErrorBody(resp));
      }
      try {
        const order = await storage.createWalletTopupOrder({ orderId, userId: user.id, amountKopecks });
        await storage.updateWalletTopupOrder(order.id, {
          paymentId: resp.PaymentId != null ? String(resp.PaymentId) : null,
          paymentUrl: resp.PaymentURL,
        });
      } catch (dbErr) {
        log(`[tbank] failed to persist wallet topup order: ${(dbErr as Error)?.message ?? "?"}`, "tbank");
        return res.status(500).json({ error: "Не удалось сохранить заказ оплаты. Попробуйте позже." });
      }
      res.json({ orderId, paymentUrl: resp.PaymentURL, amountKopecks });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось создать оплату. Попробуйте позже." });
    }
  });

  // Status of a wallet top-up order for the post-redirect result page. The
  // rider may only read their OWN order.
  app.get("/api/payments/tbank/wallet/:orderId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const order = await storage.getWalletTopupOrder(req.params.orderId);
    if (!order || order.userId !== userId) {
      return res.status(404).json({ error: "Заказ не найден" });
    }
    res.json({
      orderId: order.orderId,
      status: order.status,
      amountKopecks: order.amountKopecks,
      error: order.lastErrorMessage ?? undefined,
      errorCode: order.lastErrorCode ?? undefined,
      errorMessage: order.lastErrorMessage ?? undefined,
      errorDetails: order.lastErrorDetails ?? undefined,
    });
  });

  // Public T-Bank notification webhook. T-Bank POSTs payment/binding status
  // updates here with a Token we verify against the terminal password. We answer
  // the literal "OK" (HTTP 200) ONLY after the update has been durably persisted;
  // if processing fails we return 500 so the acquirer RETRIES the notification
  // (T-Bank keeps retrying until it receives "OK"). Acking before the DB write
  // completed would silently drop a payment confirmation (audit H2). An
  // invalid/missing token is rejected with 403. Handlers are idempotent
  // (order.status === "paid" short-circuits, ride start is guarded), so a retry
  // of an already-processed notification never double-charges or double-starts.
  app.post("/api/payments/tbank/notification", async (req, res) => {
    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!verifyNotificationToken(body, cfg.password)) {
      log("[tbank] notification rejected: bad token", "tbank");
      return res.status(403).json({ error: "Bad token" });
    }

    try {
      // Await so the HTTP response is sent ONLY after the DB write succeeds and
      // so an async rejection is caught here instead of crashing unhandled.
      await handleTbankNotification(body, cfg);
    } catch (err) {
      // Do NOT ack: return 500 so T-Bank retries later. Idempotent handlers make
      // the retry safe. Out-of-band reconciliation via GetState remains possible.
      log(`[tbank] notification processing error: ${(err as Error)?.message ?? "?"}`, "tbank");
      return res.status(500).type("text/plain").send("ERROR");
    }

    // T-Bank expects the literal string "OK" with HTTP 200.
    res.status(200).type("text/plain").send("OK");
  });

  // Refresh a pending T-Bank AddCard binding. The shared reconciliation helper
  // is also used on list/load and before a new bind, so every entry point maps
  // the authoritative bank response to the same local lifecycle transition.
  app.post("/api/payment-methods/:id/refresh", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });

    const method = await storage.getPaymentMethod(Number(req.params.id));
    if (!method) return res.status(404).json({ error: "Способ оплаты не найден" });
    const actor = await storage.getUser(userId);
    const isStaff = actor?.role === "admin" || actor?.role === "operator";
    if (method.userId !== userId && !isStaff) {
      return res.status(404).json({ error: "Способ оплаты не найден" });
    }
    if (method.provider !== "tbank" || !method.requestKey) {
      return res.status(400).json({ error: "Для этого способа оплаты проверка статуса недоступна." });
    }
    if (method.status !== "pending") return res.json(method);

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });
    if (await reconcilePendingCardBinding(method, cfg) === "unavailable") {
      return res.status(502).json({ error: "Не удалось проверить статус. Попробуйте позже." });
    }
    return res.json(await storage.getPaymentMethod(method.id));
  });

  // Refresh a pending Init+Recurrent binding through the same reconciliation
  // path as page load and the duplicate-bind guard.
  app.get("/api/payments/tbank/refresh-bind/:paymentMethodId", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });

    const method = await storage.getPaymentMethod(Number(req.params.paymentMethodId));
    if (!method) return res.status(404).json({ error: "Способ оплаты не найден" });
    const actor = await storage.getUser(userId);
    const isStaff = actor?.role === "admin" || actor?.role === "operator";
    if (method.userId !== userId && !isStaff) {
      return res.status(404).json({ error: "Способ оплаты не найден" });
    }
    if (method.provider !== "tbank" || !method.paymentId) {
      return res.status(400).json({ error: "Для этого способа оплаты проверка статуса недоступна." });
    }
    if (method.status !== "pending") return res.json(method);

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });
    if (await reconcilePendingCardBinding(method, cfg) === "unavailable") {
      return res.status(502).json({ error: "Не удалось проверить статус. Попробуйте позже." });
    }
    return res.json(await storage.getPaymentMethod(method.id));
  });

}

/**
 * Shared unlink operation for the payment-methods screen and account erasure.
 * For T-Bank cards it first revokes the CardId at the acquirer; local metadata
 * is deleted only after that succeeds. T-Bank's AddAccountQr API does not
 * expose a corresponding account-revocation endpoint, so an SBP AccountToken
 * is removed locally, which makes it unusable for any future merchant charge.
 */
export async function unlinkPaymentMethodForUser(
  userId: string,
  method: PaymentMethod,
  ip?: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (method.provider === "tbank" && method.type === "card" && method.cardId && method.customerKey) {
    const cfg = getTbankConfig();
    if (!cfg) {
      return {
        ok: false,
        status: 503,
        error: "Не удалось отвязать карту в платёжном сервисе. Попробуйте позже.",
      };
    }
    const remote = await tbankRemoveCard(cfg, {
      customerKey: method.customerKey,
      cardId: method.cardId,
      ip,
    });
    if (!remote.Success) {
      return {
        ok: false,
        status: 502,
        error: "Не удалось отвязать карту в платёжном сервисе. Попробуйте позже.",
      };
    }
  }

  const ok = await storage.unlinkPaymentMethod(userId, method.id);
  return ok
    ? { ok: true }
    : { ok: false, status: 404, error: "Способ оплаты не найден" };
}

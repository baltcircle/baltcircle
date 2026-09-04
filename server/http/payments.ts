import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { errMessage } from "../error-utils";
import { z } from "zod";
import { TARIFFS, tariffPriceKopecks, MAX_ACTIVE_RIDES_PER_USER } from "@shared/geo";
import {
  insertMapObjectSchema, otpStartSchema, otpVerifySchema, updateProfileSchema,
  adminSetRoleSchema, adminSetBlockedSchema,
  phoneChangeStartSchema, phoneChangeVerifySchema,
  linkPaymentMethodSchema, createSupportTicketSchema, rideInitPaymentSchema,
  rideChargeSavedCardSchema, rideExtendSavedCardSchema, walletTopupInitSchema,
  adminCreateBikeSchema, adminUpdateBikeSchema,
  createTicketSchema, updateTicketSchema, addTicketCommentSchema,
  adminCreateParkingSchema, adminUpdateParkingSchema, updateMapObjectSchema,
} from "@shared/schema";
import type { PaymentMethod, PaymentOrder, Ride } from "@shared/schema";
import { sendOtpSms, getSmsDiagnostics, smsProvider, getSigmaSmsSendingStatus } from "./../sms";
import {
  getTbankConfig, getTbankDiagnostics, isTbankConfigured, tbankAddCard,
  verifyNotificationToken,
  tbankInitRidePayment, generateRideOrderId, classifyRidePayment,
  tbankInitSavedCardCharge, tbankCharge, generateSavedCardRideOrderId,
  generateWalletTopupOrderId,
  tbankAddAccountQr, tbankGetAddAccountQrState, tbankRemoveCard,
  generateSbpBindOrderId, extractQrPayload, classifyAccountBinding,
  tbankInitSbpCharge, tbankChargeQr, generateSbpRideChargeOrderId,
  generateExtendRideOrderId,
} from "./../tbank";
import {
  startRideForPaidOrder, extendRideForPaidOrder, tbankErrorBody, handleTbankNotification,
  bindingErrorPatch, bindViaVerificationPayment,
} from "./../payments/tbank-handlers";
import { log } from "./../index";
import {
  riderId, isStaffSession, canManageRide, actorName, clientIp,
  requireRole, requireAuth, requireRoleWhenConfigured,
  otpLimiter, paymentLimiter, tbankWebhookLimiter,
} from "./context";
import {
  reconcilePendingCardBinding, reconcilePendingCardBindingsForUser,
  supersedePendingCardBindingsForUser,
} from "./payments/binding-reconciliation";
import { toPublicPaymentMethod, toPublicPaymentMethodOrNull } from "./payments/dto";

// Audit HIGH #2: /ride/init and /ride/charge-saved-card require a client
// idempotency key so a retried request (double-click, network drop + resend)
// replays the original order/charge instead of creating a second one. Only
// the web client in this repo calls these routes, so the header can be a hard
// requirement rather than an optional best-effort hint.
export const IDEMPOTENCY_KEY_MAX_LEN = 100;

export function readIdempotencyKey(req: Request): { key: string } | { error: string } {
  const raw = req.get("Idempotency-Key");
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { error: "Отсутствует заголовок Idempotency-Key" };
  if (key.length > IDEMPOTENCY_KEY_MAX_LEN) return { error: "Некорректный Idempotency-Key" };
  return { key };
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
    if (!cfg) return res.json(methods.map(toPublicPaymentMethod));

    // A page visit is a return from the hosted form just as much as a webhook
    // is. Resolve every pending card before returning the list, so abandoned
    // rows cannot become a durable UI/database state.
    await reconcilePendingCardBindingsForUser(userId, cfg, methods);
    res.json((await storage.listPaymentMethods(userId)).map(toPublicPaymentMethod));
  });
  app.post("/api/payment-methods", requireAuth, async (req, res) => {
    const parsed = linkPaymentMethodSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.status(201).json(toPublicPaymentMethod(await storage.linkPaymentMethod(riderId(req), parsed.data.type)));
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
    } catch (err) {
      const message = errMessage(err);
      res.status(502).json({ error: message ?? "Не удалось привязать карту. Попробуйте позже." });
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
      } catch (err) {
        const message = errMessage(err);
        return res.status(502).json({ error: message ?? "Не удалось привязать карту. Попробуйте позже." });
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
    } catch (err) {
      const message = errMessage(err);
      res.status(502).json({ error: message ?? "Не удалось привязать счёт СБП. Попробуйте позже." });
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
      return res.json(toPublicPaymentMethod(method)); // already resolved; nothing to poll
    }

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    let resp;
    try {
      resp = await tbankGetAddAccountQrState(cfg, method.requestKey);
    } catch (err) {
      const message = errMessage(err);
      return res.status(502).json({ error: message ?? "Не удалось проверить статус. Попробуйте позже." });
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
      return res.json(toPublicPaymentMethodOrNull(updated));
    }
    if (outcome === "failed") {
      const updated = await storage.updatePaymentMethod(method.id, {
        status: "failed",
        ...bindingErrorPatch(resp),
      });
      return res.json(toPublicPaymentMethodOrNull(updated));
    }
    // Still pending — report the row unchanged. Although SBP does not take
    // part in the card-binding guard, status polling should not manufacture a
    // lifecycle update when the acquirer has reported no transition.
    return res.json(toPublicPaymentMethod(method));
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
    // Aligned to the same rider-facing wording used by the QR-scan flow and
    // ride.ts's rental-start check (bike-status lifecycle spec): "rented" gets
    // its own phrase, every other non-rentable status is generic (no raw status leak).
    if (bike.status === "rented") {
      return res.status(409).json({ error: "Велосипед находиться в аренде" });
    }
    if (bike.status !== "available" && bike.status !== "reserved") {
      return res.status(409).json({ error: "Велосипед недоступен" });
    }
    if ((await storage.getActiveRides(userId)).length >= MAX_ACTIVE_RIDES_PER_USER) {
      return res.status(409).json({ error: `У вас уже максимум активных поездок (${MAX_ACTIVE_RIDES_PER_USER})` });
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
    } catch (err) {
      const message = errMessage(err);
      res.status(502).json({ error: message ?? "Не удалось создать оплату. Попробуйте позже." });
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
    // Aligned to the same rider-facing wording used by the QR-scan flow and
    // ride.ts's rental-start check (bike-status lifecycle spec): "rented" gets
    // its own phrase, every other non-rentable status is generic (no raw status leak).
    if (bike.status === "rented") {
      return res.status(409).json({ error: "Велосипед находиться в аренде" });
    }
    if (bike.status !== "available" && bike.status !== "reserved") {
      return res.status(409).json({ error: "Велосипед недоступен" });
    }
    if ((await storage.getActiveRides(userId)).length >= MAX_ACTIVE_RIDES_PER_USER) {
      return res.status(409).json({ error: `У вас уже максимум активных поездок (${MAX_ACTIVE_RIDES_PER_USER})` });
    }

    const tariffDef = TARIFFS.find((t) => t.id === parsed.data.tariffId);
    if (!tariffDef) return res.status(400).json({ error: "Неизвестный тариф" });
    const amountKopecks = Math.round(tariffDef.price * 100);

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    // Resolve a usable saved payment method — a card (RebillId) OR a bound
    // SBP account (AccountToken). When paymentMethodId is given it must match
    // that exact method; otherwise the most recently active card wins, then
    // the most recently active SBP account. When neither exists the client
    // should fall back to the hosted payment flow.
    const card = await storage.getActiveSavedCard(userId, parsed.data.paymentMethodId);
    const sbp = card ? undefined : await storage.getActiveSavedSbp(userId, parsed.data.paymentMethodId);
    const method = card ?? sbp;
    if (!method) {
      return res.status(409).json({ error: "Нет сохранённого способа оплаты для списания. Выберите другой способ." });
    }
    const kind: "card" | "sbp" = card ? "card" : "sbp";

    const orderId = kind === "card" ? generateSavedCardRideOrderId() : generateSbpRideChargeOrderId();

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
        source: kind === "card" ? "saved_card" : "saved_sbp",
        paymentMethodId: method.id,
        // Write-once audit copy — only meaningful for the card path (see
        // reserveRidePaymentOrder). We intentionally do NOT mirror the SBP
        // AccountToken here to avoid widening the payment_orders schema for a
        // field that's never read back.
        rebillId: kind === "card" ? (card!.rebillId ?? undefined) : undefined,
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
      // Step 1: Init registers the payment object and yields a PaymentId. The
      // card and SBP paths use distinct Init variants (SBP sets Recurrent=Y +
      // DATA.QR, per tbankInitSbpCharge's contract) but converge on the same
      // PaymentId-based Charge step below.
      const init = kind === "card"
        ? await tbankInitSavedCardCharge(cfg, {
            orderId,
            amountKopecks,
            customerKey: method.customerKey ?? user.id,
            description: `Аренда велосипеда ${bike.id} • ${tariffDef.name}`,
            customerEmail: user.email,
            customerPhone: user.phone,
            notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
          })
        : await tbankInitSbpCharge(cfg, {
            orderId,
            amountKopecks,
            description: `Аренда велосипеда ${bike.id} • ${tariffDef.name}`,
            customerKey: method.customerKey ?? user.id,
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

      // Step 2: Charge debits the saved method using PaymentId + RebillId (card)
      // or PaymentId + AccountToken (SBP).
      const charge = kind === "card"
        ? await tbankCharge(cfg, { paymentId, rebillId: card!.rebillId! })
        : await tbankChargeQr(cfg, { paymentId, accountToken: sbp!.accountToken! });
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
    } catch (err) {
      const message = errMessage(err);
      return res.status(502).json({ error: message ?? "Не удалось списать оплату. Попробуйте позже." });
    }
  });

  // Extend the rider's OWN active ride by charging their saved card/SBP method
  // — the card-based counterpart to /api/rides/:id/extend (which debits the
  // wallet). Mirrors /ride/charge-saved-card structurally (idempotency-first,
  // reserve-before-acquirer-call, Init+Charge, classify outcome) but on "paid"
  // applies the charge to the EXISTING ride via extendRideForPaidOrder instead
  // of starting a new one. bikeId/rideId are resolved server-side from the
  // rider's active ride — never taken from the request body — so a tampered
  // payload can never extend or charge for someone else's ride.
  app.post("/api/payments/tbank/ride/extend-saved-card", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (user.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }

    const idem = readIdempotencyKey(req);
    if ("error" in idem) return res.status(400).json({ error: idem.error });

    const parsed = rideExtendSavedCardSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }

    // Idempotency check BEFORE any ride/tariff validation or acquirer call
    // (same audit HIGH #2 rule as charge-saved-card — Charge moves real money).
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
      return res.json({ orderId: existingByKey.orderId, status: "pending", amountKopecks: existingByKey.amountKopecks });
    }

    // Never trust the client-supplied rideId directly (see the schema's
    // comment): the charge only ever applies to a ride we've independently
    // confirmed belongs to this rider AND is still active.
    const activeRide = (await storage.getActiveRides(userId)).find((r) => r.id === parsed.data.rideId);
    if (!activeRide) return res.status(409).json({ error: "Нет активной поездки" });

    const tariffDef = TARIFFS.find((t) => t.id === parsed.data.tariffId);
    if (!tariffDef) return res.status(400).json({ error: "Неизвестный тариф" });
    const amountKopecks = Math.round(tariffDef.price * 100);

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    const card = await storage.getActiveSavedCard(userId, parsed.data.paymentMethodId);
    const sbp = card ? undefined : await storage.getActiveSavedSbp(userId, parsed.data.paymentMethodId);
    const method = card ?? sbp;
    if (!method) {
      return res.status(409).json({ error: "Нет сохранённого способа оплаты для списания. Выберите другой способ." });
    }
    const kind: "card" | "sbp" = card ? "card" : "sbp";

    const orderId = generateExtendRideOrderId();

    let order: PaymentOrder;
    try {
      const reserved = await storage.reserveRidePaymentOrder({
        orderId,
        userId: user.id,
        bikeId: activeRide.bikeId,
        tariffId: tariffDef.id,
        amountKopecks,
        source: kind === "card" ? "saved_card" : "saved_sbp",
        paymentMethodId: method.id,
        rebillId: kind === "card" ? (card!.rebillId ?? undefined) : undefined,
        idempotencyKey: idem.key,
        // Set at RESERVE time — the discriminator that tells
        // handleRidePaymentNotification/this route to extend the ride instead
        // of starting a new one (see reserveRidePaymentOrder).
        rideId: activeRide.id,
      });
      if (!reserved.created) {
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
      log(`[tbank] failed to reserve extend order: ${(dbErr as Error)?.message ?? "?"}`, "tbank");
      return res.status(500).json({ error: "Не удалось сохранить заказ оплаты. Попробуйте позже." });
    }

    try {
      const init = kind === "card"
        ? await tbankInitSavedCardCharge(cfg, {
            orderId,
            amountKopecks,
            customerKey: method.customerKey ?? user.id,
            description: `Продление аренды ${activeRide.bikeId} • ${tariffDef.name}`,
            customerEmail: user.email,
            customerPhone: user.phone,
            notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
          })
        : await tbankInitSbpCharge(cfg, {
            orderId,
            amountKopecks,
            description: `Продление аренды ${activeRide.bikeId} • ${tariffDef.name}`,
            customerKey: method.customerKey ?? user.id,
            notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
          });
      if (!init.Success || init.PaymentId == null) {
        await storage.updateRidePaymentOrder(order.id, { status: "failed", ...bindingErrorPatch(init) });
        return res.status(502).json(tbankErrorBody(init));
      }
      const paymentId = String(init.PaymentId);

      try {
        await storage.updateRidePaymentOrder(order.id, { paymentId });
      } catch (dbErr) {
        log(`[tbank] failed to persist extend order: ${(dbErr as Error)?.message ?? "?"}`, "tbank");
        return res.status(500).json({ error: "Не удалось сохранить заказ оплаты. Попробуйте позже." });
      }

      const charge = kind === "card"
        ? await tbankCharge(cfg, { paymentId, rebillId: card!.rebillId! })
        : await tbankChargeQr(cfg, { paymentId, accountToken: sbp!.accountToken! });
      const status = typeof charge.Status === "string" ? charge.Status : "";
      const outcome = classifyRidePayment({ status, success: charge.Success === false ? false : undefined });

      if (outcome === "paid") {
        // Apply the charge to the SAME ride the order was reserved against (guarded
        // — a racing webhook cannot double-apply). Shared with the webhook path via
        // extendRideForPaidOrder().
        const extended = await extendRideForPaidOrder(order, paymentId);
        if (!extended.ok) {
          return res.status(409).json({ error: extended.reason });
        }
        return res.json({ orderId, status: "paid", rideId: extended.rideId, amountKopecks });
      }

      if (outcome === "failed") {
        await storage.updateRidePaymentOrder(order.id, {
          status: "failed",
          paymentId,
          ...bindingErrorPatch(charge),
        });
        return res.status(402).json(tbankErrorBody(charge));
      }

      // Deferred (e.g. 3DS step-up). Leave pending; the webhook resolves it and
      // the client polls the status endpoint below.
      return res.json({ orderId, status: "pending", amountKopecks });
    } catch (err) {
      const message = errMessage(err);
      return res.status(502).json({ error: message ?? "Не удалось списать оплату. Попробуйте позже." });
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
    // Audit LOW: only a status="failed" order's lastError* came straight from
    // a live T-Bank rejection (bindingErrorPatch(resp)), so only that case
    // needs the tbankErrorBody rider-facing allowlist. Any other status
    // (e.g. "paid" with lastErrorMessage explaining a post-charge ride-start
    // failure) carries OUR OWN already-safe diagnostic text, never a raw
    // acquirer code, and passes through unfiltered.
    const failureDetail = order.status === "failed"
      ? tbankErrorBody({
          ErrorCode: order.lastErrorCode ?? undefined,
          Message: order.lastErrorMessage ?? undefined,
          Details: order.lastErrorDetails ?? undefined,
        })
      : { error: order.lastErrorMessage ?? undefined, code: undefined, message: undefined, details: undefined };
    res.json({
      orderId: order.orderId,
      status: order.status,
      bikeId: order.bikeId,
      tariffId: order.tariffId,
      amountKopecks: order.amountKopecks,
      rideId: order.rideId,
      error: failureDetail.error,
      errorCode: failureDetail.code,
      errorMessage: failureDetail.message,
      errorDetails: failureDetail.details,
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
    } catch (err) {
      const message = errMessage(err);
      res.status(502).json({ error: message ?? "Не удалось создать оплату. Попробуйте позже." });
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
    // Audit LOW: see the analogous ride-order endpoint above — only a
    // status="failed" order's lastError* is a raw T-Bank rejection that needs
    // the tbankErrorBody rider-facing allowlist.
    const failureDetail = order.status === "failed"
      ? tbankErrorBody({
          ErrorCode: order.lastErrorCode ?? undefined,
          Message: order.lastErrorMessage ?? undefined,
          Details: order.lastErrorDetails ?? undefined,
        })
      : { error: order.lastErrorMessage ?? undefined, code: undefined, message: undefined, details: undefined };
    res.json({
      orderId: order.orderId,
      status: order.status,
      amountKopecks: order.amountKopecks,
      error: failureDetail.error,
      errorCode: failureDetail.code,
      errorMessage: failureDetail.message,
      errorDetails: failureDetail.details,
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
  app.post("/api/payments/tbank/notification", tbankWebhookLimiter, async (req, res) => {
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
    if (method.status !== "pending") return res.json(toPublicPaymentMethod(method));

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });
    if (await reconcilePendingCardBinding(method, cfg) === "unavailable") {
      return res.status(502).json({ error: "Не удалось проверить статус. Попробуйте позже." });
    }
    return res.json(toPublicPaymentMethodOrNull(await storage.getPaymentMethod(method.id)));
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
    if (method.status !== "pending") return res.json(toPublicPaymentMethod(method));

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });
    if (await reconcilePendingCardBinding(method, cfg) === "unavailable") {
      return res.status(502).json({ error: "Не удалось проверить статус. Попробуйте позже." });
    }
    return res.json(toPublicPaymentMethodOrNull(await storage.getPaymentMethod(method.id)));
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

import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { z } from "zod";
import { TARIFFS, tariffPriceKopecks } from "@shared/geo";
import {
  insertMapObjectSchema, otpStartSchema, otpVerifySchema, updateProfileSchema,
  adminSetRoleSchema, adminSetBlockedSchema,
  phoneChangeStartSchema, phoneChangeVerifySchema,
  linkPaymentMethodSchema, createSupportTicketSchema, rideInitPaymentSchema,
  rideChargeSavedCardSchema,
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
  tbankGetState,
  tbankAddAccountQr, tbankGetAddAccountQrState,
  generateSbpBindOrderId, extractQrPayload, classifyAccountBinding,
} from "./../tbank";
import type { TbankConfig } from "./../tbank";
import {
  startRideForPaidOrder, tbankErrorBody, handleTbankNotification,
  bindingErrorPatch, refundVerificationCharge, bindViaVerificationPayment,
  maskPan, cardBrand,
} from "./../payments/tbank-handlers";
import { log } from "./../index";
import {
  riderId, isStaffSession, canManageRide, actorName, clientIp,
  requireRole, requireAuth, requireRoleWhenConfigured,
  otpLimiter, paymentLimiter,
} from "./context";

export function registerPaymentRoutes(app: Express): void {
  // -------------- Payment methods (MVP metadata only) --------------
  // Per-user linked payment methods. No card numbers / CVC are ever accepted or
  // stored — only the method kind, a masked label, and a status. No real
  // acquiring is performed.
  app.get("/api/payment-methods", requireAuth, async (req, res) => {
    res.json(await storage.listPaymentMethods(riderId(req)));
  });
  app.post("/api/payment-methods", requireAuth, async (req, res) => {
    const parsed = linkPaymentMethodSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.status(201).json(await storage.linkPaymentMethod(riderId(req), parsed.data.type));
  });
  app.delete("/api/payment-methods/:id", requireAuth, async (req, res) => {
    const ok = await storage.unlinkPaymentMethod(riderId(req), Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "Способ оплаты не найден" });
    res.json({ ok: true });
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

    const blocking = await storage.getBlockingCard(user.id);
    if (blocking) {
      return res.status(409).json({
        error: blocking.status === "pending"
          ? "Карта уже привязывается. Дождитесь завершения."
          : "Карта уже привязана. Сначала удалите текущую, чтобы добавить другую.",
      });
    }

    try {
      const resp = await tbankAddCard(cfg, { customerKey: user.id });
      if (!resp.Success || !resp.PaymentURL) {
        // AddCard rejected (some terminals don't support card binding without a
        // payment). Transparently FALL BACK to the Init+Recurrent 1 ₽ path so the
        // rider still gets a working binding — with the hardened refund.
        log(`[tbank] AddCard unavailable (${resp.ErrorCode ?? "?"}: ${resp.Message ?? "?"}), falling back to 1 ₽ verification payment`, "tbank");
        return void (await bindViaVerificationPayment(cfg, user.id, res));
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

    const blocking = await storage.getBlockingCard(user.id);
    if (blocking) {
      return res.status(409).json({
        error: blocking.status === "pending"
          ? "Карта уже привязывается. Дождитесь завершения."
          : "Карта уже привязана. Сначала удалите текущую, чтобы добавить другую.",
      });
    }

    await bindViaVerificationPayment(cfg, user.id, res);
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

    // Одна карта на райдера: если карта уже привязана (или привязывается прямо
    // сейчас) — не запускаем новый флоу, возвращаем понятную ошибку.
    const existing = await storage.getBlockingCard(user.id);
    if (existing) {
      const msg = existing.status === "pending"
        ? "Карта уже привязывается. Дождитесь завершения."
        : "Карта уже привязана. Сначала удалите текущую, чтобы добавить другую.";
      return res.status(409).json({ error: msg });
    }

    if (cfg.cardBindMethod === "addcard") {
      // No-charge AddCard, with automatic fallback to the 1 ₽ payment inside the
      // route handler when the terminal doesn't support charge-free binding.
      try {
        const resp = await tbankAddCard(cfg, { customerKey: user.id });
        if (!resp.Success || !resp.PaymentURL) {
          log(`[tbank] AddCard unavailable (${resp.ErrorCode ?? "?"}: ${resp.Message ?? "?"}), falling back to 1 ₽ verification payment`, "tbank");
          return void (await bindViaVerificationPayment(cfg, user.id, res));
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
    await bindViaVerificationPayment(cfg, user.id, res);
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
    // Still pending — the webhook may yet arrive; report unchanged.
    const updated = await storage.updatePaymentMethod(method.id, { status: "pending" });
    return res.json(updated);
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

    const parsed = rideInitPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
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
        successUrl: `${cfg.publicAppUrl}/payment-result?orderId=${encodeURIComponent(orderId)}`,
        failUrl: `${cfg.publicAppUrl}/payment-result?orderId=${encodeURIComponent(orderId)}`,
        notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
      });
      if (!resp.Success || !resp.PaymentURL) {
        return res.status(502).json(tbankErrorBody(resp));
      }
      try {
        const order = await storage.createRidePaymentOrder({
          orderId,
          userId: user.id,
          bikeId: bike.id,
          tariffId: tariffDef.id,
          amountKopecks,
        });
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
      res.json({ orderId, paymentUrl: resp.PaymentURL, amountKopecks });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось создать оплату. Попробуйте позже." });
    }
  });

  // Start a ride by charging the rider's SAVED card (stored RebillId) for the
  // chosen tariff — the recurring (merchant-initiated) flow, no hosted form. We
  // validate the rider/bike/tariff exactly like ride/init, resolve the price
  // server-side, then run Init + Charge against the saved card's RebillId. On a
  // synchronous CONFIRMED/AUTHORIZED we start the ride immediately and return it.
  // On a deferred state we leave the order pending and the notification webhook
  // finishes it. On failure we surface the acquirer's sanitized reason and leave
  // the bike available. No card data is ever touched — only the RebillId token.
  app.post("/api/payments/tbank/ride/charge-saved-card", paymentLimiter, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (user.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }

    const parsed = rideChargeSavedCardSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
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

    try {
      // Step 1: Init registers the payment object and yields a PaymentId.
      const init = await tbankInitSavedCardCharge(cfg, {
        orderId,
        amountKopecks,
        customerKey: card.customerKey ?? user.id,
        description: `Аренда велосипеда ${bike.id} • ${tariffDef.name}`,
        notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
      });
      if (!init.Success || init.PaymentId == null) {
        return res.status(502).json(tbankErrorBody(init));
      }
      const paymentId = String(init.PaymentId);

      // Persist the pending order BEFORE charging so a confirming webhook that
      // races our synchronous response can correlate by OrderId.
      let order: PaymentOrder;
      try {
        order = await storage.createRidePaymentOrder({
          orderId,
          userId: user.id,
          bikeId: bike.id,
          tariffId: tariffDef.id,
          amountKopecks,
          source: "saved_card",
          paymentMethodId: card.id,
          rebillId: card.rebillId,
        });
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

  // Refresh a pending T-Bank card binding by polling GetAddCardState. This is
  // the recovery path when the notification webhook never arrived (or the rider
  // closed the tab before it landed), leaving a method stuck on "pending". The
  // rider can refresh only their OWN method; staff may refresh any. The poll
  // signs ONLY RequestKey (see tbankGetAddCardState) and we map the acquirer's
  // Status/CardId to our lifecycle, persisting any error fields. Returns the
  // updated method so the UI can re-render without a separate fetch.
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
    if (method.status === "active") {
      return res.json(method); // already resolved; nothing to poll
    }

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    let resp;
    try {
      resp = await tbankGetAddCardState(cfg, method.requestKey);
    } catch (err: any) {
      return res.status(502).json({ error: err?.message ?? "Не удалось проверить статус. Попробуйте позже." });
    }

    if (!resp.Success) {
      // The poll itself was rejected (bad RequestKey, etc.). Surface the
      // acquirer's reason but do NOT mark the method failed — the binding state
      // is unknown, only our query failed.
      return res.status(502).json(tbankErrorBody(resp));
    }

    const cardId = typeof resp.CardId === "string" ? resp.CardId : "";
    const rebillId = resp.RebillId != null ? String(resp.RebillId) : "";
    const status = typeof resp.Status === "string" ? resp.Status : "";
    const pan = typeof resp.Pan === "string" ? resp.Pan : "";
    const outcome = classifyCardBinding({ status, cardId });

    if (outcome === "active") {
      const updated = await storage.updatePaymentMethod(method.id, {
        status: "active",
        cardId: cardId || method.cardId,
        rebillId: rebillId || method.rebillId,
        label: pan ? maskPan(pan) : method.label === "Карта (привязывается…)" ? "Карта" : method.label,
        brand: pan ? cardBrand(pan) ?? method.brand : method.brand,
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
    // Still pending — record any interim status detail and report unchanged.
    const updated = await storage.updatePaymentMethod(method.id, { status: "pending" });
    return res.json(updated);
  });

  // Refresh a pending Init-bind card binding by polling GetState with the stored
  // PaymentId. This is the recovery path for the PRIMARY binding flow
  // (POST /api/payments/tbank/bind-card-payment): its rows carry a PaymentId but
  // NO RequestKey, so the AddCard-only /refresh above cannot resolve them. When
  // the notification webhook never arrives (localhost, tunnel timeout, rider
  // closed the tab) the method would otherwise stay "pending" with no RebillId
  // forever. The rider can refresh only their OWN method; staff may refresh any.
  // On AUTHORIZED/CONFIRMED with a RebillId we activate the method and persist
  // rebillId/cardId/masked PAN. Returns the updated method so the UI re-renders.
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
    if (method.status === "active") {
      return res.json(method); // already resolved; nothing to poll
    }

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    let resp;
    try {
      resp = await tbankGetState(cfg, method.paymentId);
    } catch (err: any) {
      return res.status(502).json({ error: err?.message ?? "Не удалось проверить статус. Попробуйте позже." });
    }

    if (!resp.Success) {
      // The poll itself was rejected (bad PaymentId, etc.). Surface the
      // acquirer's reason but do NOT mark the method failed — the binding state
      // is unknown, only our query failed.
      return res.status(502).json(tbankErrorBody(resp));
    }

    const status = typeof resp.Status === "string" ? resp.Status : "";
    const rebillId = resp.RebillId != null ? String(resp.RebillId) : "";
    const cardId = typeof resp.CardId === "string" ? resp.CardId : "";
    const pan = typeof resp.Pan === "string" ? resp.Pan : "";
    // resp.Success is already true here (guarded above); classify by status only.
    const outcome = classifyInitBinding({ status, rebillId });

    if (outcome === "active") {
      const updated = await storage.updatePaymentMethod(method.id, {
        status: "active",
        rebillId: rebillId || method.rebillId,
        cardId: cardId || method.cardId,
        paymentId: method.paymentId,
        label: pan ? maskPan(pan) : method.label === "Карта (привязывается…)" ? "Карта" : method.label,
        brand: pan ? cardBrand(pan) ?? method.brand : method.brand,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorDetails: null,
      });
      // Reverse/refund the 1 ₽ verification charge and record the outcome so a
      // stuck rouble is observable. `status` is the fresh GetState status.
      if (method.paymentId) refundVerificationCharge(cfg, method.id, method.paymentId, status);
      return res.json(updated);
    }
    if (outcome === "failed") {
      const updated = await storage.updatePaymentMethod(method.id, {
        status: "failed",
        ...bindingErrorPatch(resp),
      });
      return res.json(updated);
    }
    // Still pending — the webhook may yet arrive; report unchanged.
    const updated = await storage.updatePaymentMethod(method.id, { status: "pending" });
    return res.json(updated);
  });
}

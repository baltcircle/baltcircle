import type { Express, Request, Response, NextFunction } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage } from "./storage";
import { z } from "zod";
import { TARIFFS } from "@shared/geo";
import {
  insertMapObjectSchema, otpStartSchema, otpVerifySchema, updateProfileSchema,
  adminSetRoleSchema, adminSetBlockedSchema,
  phoneChangeStartSchema, phoneChangeVerifySchema,
  linkPaymentMethodSchema, createSupportTicketSchema, rideInitPaymentSchema,
  adminCreateBikeSchema, adminUpdateBikeSchema,
  createTicketSchema, updateTicketSchema, addTicketCommentSchema,
  adminCreateParkingSchema, adminUpdateParkingSchema, updateMapObjectSchema,
} from "@shared/schema";
import type { UserRole, PaymentMethod, PaymentOrder } from "@shared/schema";
import { sendOtpSms } from "./sms";
import {
  getTbankConfig, getTbankDiagnostics, isTbankConfigured, tbankAddCard,
  tbankGetAddCardState, classifyCardBinding, classifyInitBinding,
  tbankInitBindCard, verifyNotificationToken, generateBindOrderId,
  tbankInitRidePayment, generateRideOrderId, classifyRidePayment,
} from "./tbank";
import { log } from "./index";

// Resolve the active rider id. A registered rider has their user id stored in
// the session; everyone else shares the seeded "demo" account so the public
// MVP (map, demo rides, analytics) keeps working without registration.
function riderId(req: Request): string {
  return req.session?.userId ?? "demo";
}

// Display name of the acting staff member for ticket history. Falls back to a
// generic label when no session user is resolvable (local dev with guard off).
function actorName(req: Request): string {
  const id = req.session?.userId;
  const user = id ? storage.getUser(id) : undefined;
  return user?.name ?? "Оператор";
}

// Best-effort client IP for consent auditing. Honours the first X-Forwarded-For
// hop (we set `trust proxy` in index.ts) and falls back to the socket address.
function clientIp(req: Request): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || undefined;
}

// Guard for operator/admin-only endpoints. Resolves the session user and checks
// the effective role (which honours the ADMIN_PHONE_NUMBERS env override).
// 401 when not registered, 403 when registered but not privileged.
function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = req.session?.userId;
    const user = id ? storage.getUser(id) : undefined;
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (!roles.includes(user.role as UserRole)) {
      return res.status(403).json({ error: "Нет доступа" });
    }
    next();
  };
}

// Guard for operator-facing mutation endpoints. To avoid locking the operator
// UI (map editor, tickets) out of local dev — where no admin exists — the guard
// is only enforced when ADMIN_PHONE_NUMBERS is configured. With the env set
// (staging/prod) it requires one of the given roles; without it the endpoints
// stay open so the MVP map editor remains testable. Defaults to operator/admin;
// service endpoints pass "mechanic" too so service staff can work tickets.
function requireRoleWhenConfigured(...roles: UserRole[]) {
  const guard = requireRole(...(roles.length ? roles : (["operator", "admin"] as UserRole[])));
  return (req: Request, res: Response, next: NextFunction) => {
    if (!process.env.ADMIN_PHONE_NUMBERS) return next();
    return guard(req, res, next);
  };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // -------------- Rider registration (SMS OTP) --------------
  // Step 1: rider submits name + phone + consent. We generate a code, persist
  // its hash, and dispatch it by SMS. No session is created yet.
  app.post("/api/auth/otp/start", async (req, res) => {
    const parsed = otpStartSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.startOtp({ name: parsed.data.name, phone: parsed.data.phone });
    if ("error" in result) {
      const status = result.retryAfterSec ? 429 : 400;
      return res.status(status).json(result);
    }
    try {
      const { devEcho } = await sendOtpSms(result.phone, result.code);
      // In dev fallback (no SMS provider configured) we echo the code so the
      // flow is testable locally. In production this is always undefined.
      res.json({
        phone: result.phone,
        resendInSec: result.resendInSec,
        ...(devEcho ? { devCode: result.code } : {}),
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось отправить SMS. Попробуйте позже." });
    }
  });

  // Step 2: rider submits the code. On success we create/activate the rider and
  // bind the session, allowing rental/scan.
  app.post("/api/auth/otp/verify", (req, res) => {
    const parsed = otpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.verifyOtp({
      phone: parsed.data.phone,
      code: parsed.data.code,
      consentIp: clientIp(req),
    });
    if ("error" in result) return res.status(400).json(result);
    req.session.userId = result.user.id;
    res.status(201).json(result.user);
  });

  app.get("/api/users/current", (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.json(null);
    const user = storage.getUser(id);
    if (!user) {
      // Session points at a user that no longer exists (e.g. DB reset). Clear
      // the stale id so the client falls back to the unregistered state.
      req.session.userId = undefined;
      return res.json(null);
    }
    res.json(user);
  });

  // Self-service profile update for the logged-in rider. Name and email only —
  // phone changes are intentionally not accepted here (they need SMS OTP).
  app.patch("/api/users/me", (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.updateProfile(id, parsed.data);
    if ("error" in result) return res.status(400).json(result);
    res.json(result.user);
  });

  // -------------- Phone change (SMS OTP, existing account) --------------
  // The current rider changes their phone number. This is the ONLY way to
  // change a phone — the profile PATCH endpoint never touches it. Step 1 sends a
  // code to the new number; step 2 verifies it and applies the change.
  app.post("/api/users/me/phone/start", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = phoneChangeStartSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.startPhoneChange({ userId: id, phone: parsed.data.phone });
    if ("error" in result) {
      const status = result.retryAfterSec ? 429 : 400;
      return res.status(status).json(result);
    }
    try {
      const { devEcho } = await sendOtpSms(result.phone, result.code);
      res.json({
        phone: result.phone,
        resendInSec: result.resendInSec,
        ...(devEcho ? { devCode: result.code } : {}),
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось отправить SMS. Попробуйте позже." });
    }
  });

  app.post("/api/users/me/phone/verify", (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = phoneChangeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.verifyPhoneChange({ userId: id, code: parsed.data.code });
    if ("error" in result) return res.status(400).json(result);
    res.json(result.user);
  });

  // -------------- Payment methods (MVP metadata only) --------------
  // Per-user linked payment methods. No card numbers / CVC are ever accepted or
  // stored — only the method kind, a masked label, and a status. No real
  // acquiring is performed.
  app.get("/api/payment-methods", (req, res) => {
    res.json(storage.listPaymentMethods(riderId(req)));
  });
  app.post("/api/payment-methods", (req, res) => {
    const parsed = linkPaymentMethodSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.status(201).json(storage.linkPaymentMethod(riderId(req), parsed.data.type));
  });
  app.delete("/api/payment-methods/:id", (req, res) => {
    const ok = storage.unlinkPaymentMethod(riderId(req), Number(req.params.id));
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
  app.get("/api/payments/tbank/config", (_req, res) => {
    res.json({ configured: isTbankConfigured() });
  });

  // Admin-only diagnostics to confirm the terminal credentials are wired up
  // correctly. Returns ONLY non-secret metadata (lengths, last-4 of the terminal
  // key, a passwordHasDollar flag) — never the password or full terminal key. A
  // password whose leading `$` was stripped by shell/compose interpolation shows
  // up as an unexpectedly short passwordLength or passwordHasDollar=false here.
  app.get("/api/payments/tbank/diagnostics", requireRole("admin"), (_req, res) => {
    res.json(getTbankDiagnostics());
  });

  // Start a card binding for the current registered rider. Calls AddCard with
  // CustomerKey = user.id and returns the PaymentURL the client opens. A pending
  // payment-method row is created so the UI can show "привязывается…" until the
  // notification confirms it.
  app.post("/api/payments/tbank/add-card", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    try {
      const resp = await tbankAddCard(cfg, { customerKey: user.id });
      if (!resp.Success || !resp.PaymentURL) {
        return res.status(502).json(tbankErrorBody(resp));
      }
      storage.createPendingCardMethod({
        userId: user.id,
        customerKey: user.id,
        requestKey: typeof resp.RequestKey === "string" ? resp.RequestKey : undefined,
      });
      res.json({ paymentUrl: resp.PaymentURL });
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
  app.post("/api/payments/tbank/bind-card-payment", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    // Unique per attempt so each binding payment correlates to exactly one row.
    // Must stay <= 50 chars or T-Bank rejects Init with code 212 (the user id is
    // a 36-char UUID, so embedding it overflowed the limit).
    const orderId = generateBindOrderId();
    const amountKopecks = cfg.cardBindAmountKopecks;

    try {
      const resp = await tbankInitBindCard(cfg, {
        orderId,
        amountKopecks,
        customerKey: user.id,
        description: "Проверочный платёж для привязки карты",
        successUrl: `${cfg.publicAppUrl}/payment-methods`,
        failUrl: `${cfg.publicAppUrl}/payment-methods`,
        notificationUrl: `${cfg.publicAppUrl}/api/payments/tbank/notification`,
      });
      if (!resp.Success || !resp.PaymentURL) {
        return res.status(502).json(tbankErrorBody(resp));
      }
      const method = storage.createPendingBindPayment({
        userId: user.id,
        customerKey: user.id,
        orderId,
        amountKopecks,
      });
      storage.updatePaymentMethod(method.id, {
        paymentId: resp.PaymentId != null ? String(resp.PaymentId) : null,
        paymentUrl: resp.PaymentURL,
      });
      res.json({ paymentUrl: resp.PaymentURL, amountKopecks });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось привязать карту. Попробуйте позже." });
    }
  });

  // Start a ride by paying its tariff up front via an ordinary T-Bank payment
  // (NO saved card / RebillId required — this is the working MVP payment path).
  // The rider pays the chosen tariff on T-Bank's hosted form; the ride is only
  // started once the notification webhook confirms the payment. We validate the
  // bike is rentable and the tariff is known, resolve the price authoritatively
  // server-side (never trusting a client amount), create a pending payment order
  // and return the PaymentURL the client opens. No card data ever reaches us.
  app.post("/api/payments/tbank/ride/init", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (user.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }

    const parsed = rideInitPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }

    const bike = storage.getBike(parsed.data.bikeId);
    if (!bike) return res.status(404).json({ error: "Велосипед не найден" });
    if (bike.status !== "available" && bike.status !== "reserved") {
      return res.status(409).json({ error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` });
    }
    if (storage.getActiveRide(userId)) {
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
        const order = storage.createRidePaymentOrder({
          orderId,
          userId: user.id,
          bikeId: bike.id,
          tariffId: tariffDef.id,
          amountKopecks,
        });
        storage.updateRidePaymentOrder(order.id, {
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

  // Status of a ride payment order for the post-redirect result page. The rider
  // may only read their OWN order. Returns the lifecycle status and, once the
  // ride has started, its id so the client can route into the active ride.
  app.get("/api/payments/tbank/ride/:orderId", (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const order = storage.getRidePaymentOrder(req.params.orderId);
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
  // updates here with a Token we verify against the terminal password. We must
  // always answer "OK" (HTTP 200) once the signature is valid, otherwise T-Bank
  // retries indefinitely. An invalid/missing token is rejected with 403.
  app.post("/api/payments/tbank/notification", (req, res) => {
    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются." });

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!verifyNotificationToken(body, cfg.password)) {
      log("[tbank] notification rejected: bad token", "tbank");
      return res.status(403).json({ error: "Bad token" });
    }

    try {
      handleTbankNotification(body);
    } catch (err) {
      // Log but still ack so T-Bank doesn't hammer us; reconciliation can be
      // done out of band via GetState.
      log(`[tbank] notification processing error: ${(err as Error)?.message ?? "?"}`, "tbank");
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

    const method = storage.getPaymentMethod(Number(req.params.id));
    if (!method) return res.status(404).json({ error: "Способ оплаты не найден" });

    const actor = storage.getUser(userId);
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
      const updated = storage.updatePaymentMethod(method.id, {
        status: "active",
        cardId: cardId || method.cardId,
        rebillId: rebillId || method.rebillId,
        label: pan ? maskPan(pan) : method.label === "Карта (привязывается…)" ? "Карта" : method.label,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorDetails: null,
      });
      return res.json(updated);
    }
    if (outcome === "failed") {
      const updated = storage.updatePaymentMethod(method.id, {
        status: "failed",
        ...bindingErrorPatch(resp),
      });
      return res.json(updated);
    }
    // Still pending — record any interim status detail and report unchanged.
    const updated = storage.updatePaymentMethod(method.id, { status: "pending" });
    return res.json(updated);
  });

  // -------------- Support tickets (rider help requests) --------------
  app.get("/api/support/tickets", (req, res) => {
    res.json(storage.listSupportTickets(riderId(req)));
  });
  app.post("/api/support/tickets", (req, res) => {
    const parsed = createSupportTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    res.status(201).json(storage.createSupportTicket({ userId: riderId(req), ...parsed.data }));
  });

  // -------------- Admin: user management --------------
  // All endpoints require an operator/admin session (401 unregistered, 403
  // registered-but-not-staff). Granting/revoking the admin role additionally
  // requires the caller to be an admin — operators may manage rider/operator
  // roles but cannot create or remove admins.
  app.get("/api/admin/users", requireRole("operator", "admin"), (_req, res) => {
    res.json(storage.listUsers());
  });

  app.patch("/api/admin/users/:id/role", requireRole("operator", "admin"), (req, res) => {
    const parsed = adminSetRoleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });

    const targetId = String(req.params.id);
    const actor = storage.getUser(req.session!.userId!)!;
    const target = storage.getUser(targetId);
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });

    // Only an admin may grant admin or change an existing admin's role.
    const touchesAdmin = parsed.data.role === "admin" || target.role === "admin";
    if (touchesAdmin && actor.role !== "admin") {
      return res.status(403).json({ error: "Только администратор может назначать роль администратора" });
    }
    // An admin can't demote themselves — avoids accidentally locking the last
    // admin out of the operator panel.
    if (actor.id === target.id && actor.role === "admin" && parsed.data.role !== "admin") {
      return res.status(400).json({ error: "Нельзя снять роль администратора с самого себя" });
    }

    const result = storage.setUserRole(targetId, parsed.data.role);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.user);
  });

  app.patch("/api/admin/users/:id/status", requireRole("operator", "admin"), (req, res) => {
    const parsed = adminSetBlockedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });

    const targetId = String(req.params.id);
    const actor = storage.getUser(req.session!.userId!)!;
    const target = storage.getUser(targetId);
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });

    if (actor.id === target.id) {
      return res.status(400).json({ error: "Нельзя заблокировать самого себя" });
    }
    // Blocking an admin requires admin privileges.
    if (target.role === "admin" && actor.role !== "admin") {
      return res.status(403).json({ error: "Недостаточно прав для блокировки администратора" });
    }

    const result = storage.setUserBlocked(targetId, parsed.data.blocked, parsed.data.reason);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.user);
  });

  // -------------- Bikes / Parkings / Zones --------------
  // Public read: archived bikes are excluded so they never reach the map or
  // rental selection. (The admin fleet page uses /api/admin/bikes for the full
  // list including archived.)
  app.get("/api/bikes", (_req, res) => res.json(storage.listBikes()));
  app.get("/api/bikes/:id", (req, res) => {
    const b = storage.getBike(req.params.id);
    if (!b) return res.status(404).json({ error: "Велосипед не найден" });
    res.json(b);
  });
  app.patch("/api/bikes/:id", (req, res) => {
    const b = storage.updateBike(req.params.id, req.body);
    if (!b) return res.status(404).json({ error: "Велосипед не найден" });
    res.json(b);
  });
  // Public read: only active, non-archived parking points reach the customer
  // app. The admin page uses /api/admin/parkings for the full list.
  app.get("/api/parkings", (_req, res) => res.json(storage.listParkings()));

  // -------------- Admin: parking management --------------
  // Staff-only CRUD over parking points. The list includes inactive + archived
  // points so operators can see/restore them; the public /api/parkings never does.
  app.get("/api/admin/parkings", requireRole("operator", "admin"), (_req, res) => {
    res.json(storage.listParkings({ includeInactive: true, includeArchived: true }));
  });
  app.post("/api/admin/parkings", requireRole("operator", "admin"), (req, res) => {
    const parsed = adminCreateParkingSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.createParking(parsed.data);
    if ("error" in result) return res.status(409).json(result);
    res.status(201).json(result.parking);
  });
  app.patch("/api/admin/parkings/:id", requireRole("operator", "admin"), (req, res) => {
    const parsed = adminUpdateParkingSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.updateParking(String(req.params.id), parsed.data);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  app.post("/api/admin/parkings/:id/archive", requireRole("operator", "admin"), (req, res) => {
    const result = storage.archiveParking(String(req.params.id));
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  // Restore returns an archived point as *inactive* so it never re-appears on
  // the public map until an operator activates it; it shows muted on admin maps.
  app.post("/api/admin/parkings/:id/restore", requireRole("operator", "admin"), (req, res) => {
    const result = storage.restoreParking(String(req.params.id));
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  app.delete("/api/admin/parkings/:id", requireRole("operator", "admin"), (req, res) => {
    const result = storage.deleteParking(String(req.params.id));
    if ("error" in result) {
      // Parking kept but archived (bikes referenced it) → 409 with archived row.
      if (result.archived) return res.status(409).json(result);
      return res.status(404).json(result);
    }
    res.json(result);
  });

  // -------------- Admin: fleet (bike) management --------------
  // Staff-only CRUD over the real fleet. The list includes archived bikes so
  // operators can see/restore them; the public /api/bikes never does.
  // Read access includes mechanics so the service staff can see the full fleet
  // (including archived) while triaging tickets; writes below stay operator/admin.
  app.get("/api/admin/bikes", requireRole("mechanic", "operator", "admin"), (_req, res) => {
    res.json(storage.listBikes({ includeArchived: true }));
  });
  app.post("/api/admin/bikes", requireRole("operator", "admin"), (req, res) => {
    const parsed = adminCreateBikeSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.createBike(parsed.data);
    if ("error" in result) return res.status(409).json(result);
    res.status(201).json(result.bike);
  });
  app.patch("/api/admin/bikes/:id", requireRole("operator", "admin"), (req, res) => {
    const parsed = adminUpdateBikeSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = storage.adminUpdateBike(String(req.params.id), parsed.data);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.bike);
  });
  app.post("/api/admin/bikes/:id/archive", requireRole("operator", "admin"), (req, res) => {
    const result = storage.archiveBike(String(req.params.id));
    if ("error" in result) {
      const status = (result.error ?? "").includes("не найден") ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result.bike);
  });
  app.delete("/api/admin/bikes/:id", requireRole("operator", "admin"), (req, res) => {
    const result = storage.deleteBike(String(req.params.id));
    if ("error" in result) {
      // Bike kept but archived (had ride history) → 409 with the archived row.
      if (result.archived) return res.status(409).json(result);
      const status = (result.error ?? "").includes("не найден") ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  });
  app.get("/api/zones", (_req, res) => res.json(storage.listZones()));

  // -------------- Rides --------------
  app.get("/api/rides", (req, res) => {
    const userId = (req.query.userId as string) ?? undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.json(storage.listRides({ userId, limit }));
  });
  app.get("/api/rides/active", (req, res) => {
    const ride = storage.getActiveRide(riderId(req));
    res.json(ride ?? null);
  });
  app.post("/api/rides/start", (req, res) => {
    const schema = z.object({ bikeId: z.string(), tariff: z.string().default("payg") });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    // A blocked account may stay logged in but cannot start new rentals.
    const sessUser = req.session?.userId ? storage.getUser(req.session.userId) : undefined;
    if (sessUser?.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }
    const r = storage.startRide({ bikeId: parsed.data.bikeId, userId: riderId(req), tariff: parsed.data.tariff });
    if ("error" in r) return res.status(400).json(r);
    res.json(r);
  });
  app.post("/api/rides/:id/point", (req, res) => {
    const schema = z.object({ x: z.number(), y: z.number() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    const r = storage.appendRidePoint(Number(req.params.id), parsed.data.x, parsed.data.y);
    if (!r) return res.status(404).json({ error: "Поездка не активна" });
    res.json(r);
  });
  app.post("/api/rides/:id/end", (req, res) => {
    const r = storage.endRide(Number(req.params.id));
    if (!r) return res.status(404).json({ error: "Поездка не активна" });
    res.json(r);
  });

  // -------------- Admin rides --------------
  // Staff-only operational view of every ride with rider identity attached.
  // 401 unregistered, 403 registered-but-not-staff (mirrors /api/admin/*).
  app.get("/api/admin/rides", requireRole("operator", "admin"), (req, res) => {
    const limit = req.query.limit ? Math.min(Number(req.query.limit) || 200, 1000) : 200;
    res.json(storage.listAdminRides({ limit }));
  });
  // Manually finish any active ride. Reuses the shared endRide() (which settles
  // cost, frees the bike and charges the wallet) but, unlike the rider endpoint,
  // an operator may end a ride that isn't their own. 404 if not active.
  app.post("/api/admin/rides/:id/end", requireRole("operator", "admin"), (req, res) => {
    const r = storage.endRide(Number(req.params.id));
    if (!r) return res.status(404).json({ error: "Поездка не активна" });
    res.json(r);
  });

  // -------------- Wallet / Payments --------------
  app.get("/api/wallet", (req, res) => res.json(storage.getWallet(riderId(req))));
  app.post("/api/wallet/topup", (req, res) => {
    const schema = z.object({ amount: z.number().positive().max(50000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.json(storage.topUp(riderId(req), parsed.data.amount));
  });
  app.post("/api/wallet/tariff", (req, res) => {
    const schema = z.object({
      tariff: z.enum(["h1", "h2", "h3"]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    // Look up authoritative price/duration server-side; never trust client-supplied values
    const tariffDef = TARIFFS.find((t) => t.id === parsed.data.tariff);
    if (!tariffDef) return res.status(400).json({ error: "Unknown tariff" });
    const durationMs = tariffDef.durationHours * 60 * 60 * 1000;
    const w = storage.getWallet(riderId(req));
    if (w.balance < tariffDef.price) {
      return res.status(400).json({ error: "Недостаточно средств на балансе" });
    }
    res.json(storage.purchaseTariff(riderId(req), parsed.data.tariff, tariffDef.price, durationMs));
  });
  app.get("/api/payments", (req, res) => res.json(storage.listPayments(riderId(req))));

  // -------------- Service / maintenance tickets --------------
  // List is open (operator UI reads it freely); all mutations are staff-gated
  // when ADMIN_PHONE_NUMBERS is configured. Service tickets are the mechanic's
  // core surface, so mechanic/operator/admin may create, update and comment.
  const requireServiceStaff = requireRoleWhenConfigured("mechanic", "operator", "admin");
  app.get("/api/tickets", (_req, res) => res.json(storage.listTickets()));
  app.get("/api/tickets/:id", (req, res) => {
    const t = storage.getTicket(Number(req.params.id));
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    res.json(t);
  });
  app.post("/api/tickets", requireServiceStaff, (req, res) => {
    const parsed = createTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Проверьте данные" });
    }
    res.status(201).json(storage.createTicket(parsed.data));
  });
  app.patch("/api/tickets/:id", requireServiceStaff, (req, res) => {
    const parsed = updateTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Проверьте данные" });
    }
    const t = storage.updateTicket(Number(req.params.id), parsed.data, actorName(req));
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    res.json(t);
  });
  app.post("/api/tickets/:id/comments", requireServiceStaff, (req, res) => {
    const parsed = addTicketCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Проверьте данные" });
    }
    const t = storage.addTicketComment(Number(req.params.id), actorName(req), parsed.data.body);
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    res.status(201).json(t);
  });

  // -------------- Map objects (operator-drawn routes/zones) --------------
  // Public read returns only active objects so inactive ones never render on the
  // customer map. The editor reads /api/admin/map-objects for the full list.
  app.get("/api/map-objects", (_req, res) => res.json(storage.listMapObjects({ activeOnly: true })));
  app.get("/api/admin/map-objects", requireRoleWhenConfigured(), (_req, res) =>
    res.json(storage.listMapObjects()),
  );
  app.post("/api/map-objects", requireRoleWhenConfigured(), (req, res) => {
    const parsed = insertMapObjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.json(storage.createMapObject(parsed.data));
  });
  app.patch("/api/map-objects/:id", requireRoleWhenConfigured(), (req, res) => {
    const parsed = updateMapObjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    const obj = storage.setMapObjectActive(Number(req.params.id), parsed.data.active);
    if (!obj) return res.status(404).json({ error: "Объект не найден" });
    res.json(obj);
  });
  app.delete("/api/map-objects/:id", requireRoleWhenConfigured(), (req, res) => {
    const ok = storage.deleteMapObject(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "Объект не найден" });
    res.json({ ok: true });
  });

  // -------------- Analytics --------------
  app.get("/api/analytics", (_req, res) => res.json(storage.analytics()));

  // Period-scoped analytics for the admin "Аналитика v1" page. Staff-only.
  // `from`/`to` are unix-ms bounds (inclusive); defaults to the last 30 days.
  app.get("/api/admin/analytics", requireRole("operator", "admin"), (req, res) => {
    const now = Date.now();
    const parseTs = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const from = parseTs(req.query.from, now - 30 * 24 * 60 * 60 * 1000);
    const to = parseTs(req.query.to, now);
    if (from > to) return res.status(400).json({ error: "Некорректный диапазон дат" });
    res.json(storage.adminAnalytics({ from, to }));
  });

  return httpServer;
}

// Build a sanitized error body for a rejected T-Bank operation. Surfaces the
// acquirer's own ErrorCode / Message / Details so the rider (and support) can
// see *why* the operation failed instead of an opaque generic message. These
// fields are produced by T-Bank and carry no terminal secret (the password is
// never echoed back), so they are safe to forward. A friendly fallback message
// is always provided when T-Bank returns nothing useful.
function tbankErrorBody(resp: {
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
// The notification is assumed signature-verified by the caller. Statuses follow
// the T-Kassa lifecycle (NEW/FORM_SHOWED/AUTHORIZED/CONFIRMED/REJECTED/...).
function handleTbankNotification(body: Record<string, unknown>): void {
  const orderId = typeof body.OrderId === "string" ? body.OrderId : "";

  if (orderId) {
    // Ordinary ride payment: correlate by our OrderId. Checked first because a
    // ride order id and a card-binding order id never collide (distinct
    // prefixes / distinct tables), and a paid ride is the time-critical action.
    const order = storage.getRidePaymentOrder(orderId);
    if (order) {
      handleRidePaymentNotification(order, body);
      return;
    }

    // Init binding path: correlate by our OrderId. A matching card_binding row
    // means this is a verification payment, not a ride/topup payment.
    const byOrder = storage.findCardMethodByOrderId(orderId);
    if (byOrder && byOrder.purpose === "card_binding") {
      handleInitBindingNotification(byOrder, body);
      return;
    }
  }

  handleAddCardNotification(body);
}

// Resolve an ordinary ride-payment order from a notification. On the first
// AUTHORIZED/CONFIRMED we start the ride (idempotently — a duplicate
// notification re-uses the already-started ride and never double-charges or
// double-starts) and record the rideId. On an explicit rejection we mark the
// order failed and leave the bike available. Intermediate states stay pending.
function handleRidePaymentNotification(
  order: PaymentOrder,
  body: Record<string, unknown>,
): void {
  if (order.status === "paid") return; // already resolved — idempotent

  const status = typeof body.Status === "string" ? body.Status : "";
  const paymentId = body.PaymentId != null ? String(body.PaymentId) : "";
  const success = body.Success === false ? false : undefined;
  const outcome = classifyRidePayment({ status, success });

  if (outcome === "paid") {
    // Start the ride for this rider/bike/tariff if one isn't already running.
    // startRide is itself guarded (it rejects when the rider has an active
    // ride or the bike isn't rentable), so a racing/duplicate notification
    // cannot create a second ride.
    let rideId = order.rideId ?? null;
    if (rideId == null) {
      const existing = storage.getActiveRide(order.userId);
      if (existing && existing.bikeId === order.bikeId) {
        rideId = existing.id;
      } else {
        const started = storage.startRide({
          bikeId: order.bikeId,
          userId: order.userId,
          tariff: order.tariffId,
        });
        if ("error" in started) {
          // Payment succeeded but the ride could not start (e.g. the bike was
          // taken in the meantime). Mark paid so we don't lose the payment
          // record; record the reason for support/refund follow-up.
          storage.updateRidePaymentOrder(order.id, {
            status: "paid",
            paymentId: paymentId || order.paymentId,
            lastErrorMessage: started.error,
          });
          return;
        }
        rideId = started.id;
      }
    }
    storage.updateRidePaymentOrder(order.id, {
      status: "paid",
      paymentId: paymentId || order.paymentId,
      rideId,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorDetails: null,
    });
  } else if (outcome === "failed") {
    storage.updateRidePaymentOrder(order.id, {
      status: "failed",
      paymentId: paymentId || order.paymentId,
      ...bindingErrorPatch(body),
    });
  }
  // Otherwise an intermediate state — leave pending; a later CONFIRMED resolves it.
}

// Resolve an Init verification-payment binding from a notification. Activates
// the method only when a RebillId is present alongside AUTHORIZED/CONFIRMED —
// the RebillId is the recurring token we need for future charges. Persists the
// PaymentId/RebillId and any acquirer error fields (never a secret).
function handleInitBindingNotification(
  method: PaymentMethod,
  body: Record<string, unknown>,
): void {
  if (method.status === "active") return; // already resolved

  const status = typeof body.Status === "string" ? body.Status : "";
  const rebillId = body.RebillId != null ? String(body.RebillId) : "";
  const cardId = typeof body.CardId === "string" ? body.CardId : "";
  const pan = typeof body.Pan === "string" ? body.Pan : "";
  const paymentId = body.PaymentId != null ? String(body.PaymentId) : "";
  const success = body.Success === false ? false : undefined;

  const outcome = classifyInitBinding({ status, rebillId, success });
  if (outcome === "active") {
    storage.updatePaymentMethod(method.id, {
      status: "active",
      rebillId: rebillId || method.rebillId,
      cardId: cardId || method.cardId,
      paymentId: paymentId || method.paymentId,
      label: pan ? maskPan(pan) : "Карта",
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorDetails: null,
    });
  } else if (outcome === "failed") {
    storage.updatePaymentMethod(method.id, {
      status: "failed",
      paymentId: paymentId || method.paymentId,
      ...bindingErrorPatch(body),
    });
  }
  // Otherwise an intermediate state — leave pending; a later notification
  // (CONFIRMED with RebillId) will activate it.
}

// Resolve an AddCard binding (fallback path) from a notification keyed by
// CustomerKey. Unchanged from the original AddCard-only behavior.
function handleAddCardNotification(body: Record<string, unknown>): void {
  const status = typeof body.Status === "string" ? body.Status : "";
  const customerKey = typeof body.CustomerKey === "string" ? body.CustomerKey : "";
  const cardId = typeof body.CardId === "string" ? body.CardId : "";
  const rebillId = body.RebillId != null ? String(body.RebillId) : "";
  const pan = typeof body.Pan === "string" ? body.Pan : "";
  // T-Bank may signal failure via Success=false even without a terminal Status.
  const success = body.Success === false ? false : undefined;

  if (!customerKey) return;
  const pending = storage.findPendingCardMethod(customerKey);
  if (!pending) return;

  const outcome = classifyCardBinding({ status, cardId });
  if (outcome === "active") {
    storage.updatePaymentMethod(pending.id, {
      status: "active",
      cardId: cardId || pending.cardId,
      rebillId: rebillId || pending.rebillId,
      label: pan ? maskPan(pan) : "Карта",
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorDetails: null,
    });
  } else if (outcome === "failed" || success === false) {
    // An explicit rejection (or Success=false) ends the binding. Persist the
    // acquirer's error fields so the rider/support can see *why* — never a
    // secret, these come straight from T-Bank.
    storage.updatePaymentMethod(pending.id, {
      status: "failed",
      ...bindingErrorPatch(body),
    });
  }
  // Otherwise an intermediate state — leave the method pending; the rider can
  // refresh it explicitly or the next notification will resolve it.
}

// Extract T-Bank's error fields from a notification/state response into the
// payment_methods error columns. Acquirer-produced, non-secret values only.
function bindingErrorPatch(body: {
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

// Build a masked PAN label from a T-Bank-provided masked pan. T-Bank already
// sends a masked value (e.g. "430000******0777"); we render the last 4 digits.
function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return last4 ? `•••• ${last4}` : "Карта";
}

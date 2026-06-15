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
  linkPaymentMethodSchema, createSupportTicketSchema, initRidePaymentSchema,
  adminCreateBikeSchema, adminUpdateBikeSchema,
  createTicketSchema, updateTicketSchema, addTicketCommentSchema,
  adminCreateParkingSchema, adminUpdateParkingSchema, updateMapObjectSchema,
} from "@shared/schema";
import type { UserRole } from "@shared/schema";
import { sendOtpSms } from "./sms";
import {
  getTbankConfig, isTbankConfigured, tbankInit, tbankAddCard, verifyNotificationToken,
} from "./tbank";
import { randomUUID } from "node:crypto";
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
      const resp = await tbankAddCard(cfg, { customerKey: user.id, checkType: "3DS" });
      if (!resp.Success || !resp.PaymentURL) {
        return res.status(502).json({ error: tbankUserError(resp) });
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

  // Create a ride payment for the current rider. The amount is resolved from the
  // tariff table server-side (never trusted from the client) and converted to
  // kopecks. Returns the PaymentURL the rider opens to pay. The ride is NOT
  // started here — it is activated by the notification once payment is confirmed.
  app.post("/api/payments/tbank/init-ride-payment", async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Требуется вход" });
    const user = storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (user.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }

    const parsed = initRidePaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Проверьте данные" });
    }

    const cfg = getTbankConfig();
    if (!cfg) return res.status(503).json({ error: "Платежи настраиваются. Попробуйте позже." });

    const bike = storage.getBike(parsed.data.bikeId);
    if (!bike) return res.status(404).json({ error: "Велосипед не найден" });

    const tariffDef = TARIFFS.find((t) => t.id === parsed.data.tariffId);
    if (!tariffDef) return res.status(400).json({ error: "Неизвестный тариф" });
    const amountKopecks = Math.round(tariffDef.price * 100);

    const orderId = `ride-${user.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const order = storage.createPaymentOrder({
      orderId,
      userId: user.id,
      bikeId: bike.id,
      tariffId: tariffDef.id,
      kind: "ride",
      amountKopecks,
    });

    try {
      const resp = await tbankInit(cfg, {
        orderId,
        amountKopecks,
        customerKey: user.id,
        description: `Аренда ${bike.id} • ${tariffDef.name}`,
      });
      if (!resp.Success || !resp.PaymentURL) {
        storage.updatePaymentOrder(order.id, { status: "failed" });
        return res.status(502).json({ error: tbankUserError(resp) });
      }
      storage.updatePaymentOrder(order.id, {
        providerPaymentId: resp.PaymentId != null ? String(resp.PaymentId) : null,
        paymentUrl: resp.PaymentURL,
      });
      res.json({ paymentUrl: resp.PaymentURL, orderId });
    } catch (err: any) {
      storage.updatePaymentOrder(order.id, { status: "failed" });
      res.status(502).json({ error: err?.message ?? "Не удалось создать платёж. Попробуйте позже." });
    }
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

// Map a T-Bank error response to a safe, user-facing Russian message. Never
// surfaces the raw acquirer Details (which can leak internal info) to the
// client; the full ErrorCode/Message is already logged in the client module.
function tbankUserError(resp: { ErrorCode?: string; Message?: string }): string {
  const code = resp.ErrorCode ?? "";
  if (code === "0" || code === "") return resp.Message || "Не удалось выполнить операцию.";
  return "Платёжный сервис отклонил операцию. Попробуйте позже или другую карту.";
}

// Process a verified T-Bank notification. Two flows are handled:
//   1. Card binding (AddCard) — a notification carrying CardId/Status for a
//      CustomerKey activates the rider's pending card method.
//   2. Ride payment (Init) — a CONFIRMED/AUTHORIZED payment for one of our
//      OrderIds activates the ride (starts it) if the bike is still rentable;
//      a rejected/cancelled payment marks the order failed.
//
// The notification is assumed signature-verified by the caller. Statuses follow
// the T-Kassa lifecycle (NEW/FORM_SHOWED/AUTHORIZED/CONFIRMED/REJECTED/...).
function handleTbankNotification(body: Record<string, unknown>): void {
  const status = typeof body.Status === "string" ? body.Status : "";
  const orderId = typeof body.OrderId === "string" ? body.OrderId : "";
  const customerKey = typeof body.CustomerKey === "string" ? body.CustomerKey : "";
  const cardId = typeof body.CardId === "string" ? body.CardId : "";
  const rebillId = body.RebillId != null ? String(body.RebillId) : "";
  const pan = typeof body.Pan === "string" ? body.Pan : "";

  // ----- Card binding notification (no OrderId, carries CustomerKey/CardId) -----
  if (!orderId && customerKey) {
    const pending = storage.findPendingCardMethod(customerKey);
    if (!pending) return;
    // A binding succeeds once the acquirer returns a CardId; an explicit failure
    // status marks it failed. Anything else (intermediate state) is ignored.
    if (cardId) {
      storage.updatePaymentMethod(pending.id, {
        status: "active",
        cardId,
        rebillId: rebillId || null,
        label: pan ? maskPan(pan) : "Карта",
      });
    } else if (status === "REJECTED" || status === "DEADLINE_EXPIRED") {
      storage.updatePaymentMethod(pending.id, { status: "failed" });
    }
    return;
  }

  // ----- Ride payment notification (carries our OrderId) -----
  if (!orderId) return;
  const order = storage.getPaymentOrderByOrderId(orderId);
  if (!order) return;

  const failedStatuses = ["REJECTED", "CANCELED", "CANCELLED", "DEADLINE_EXPIRED", "REVERSED", "REFUNDED"];
  if (failedStatuses.includes(status)) {
    storage.updatePaymentOrder(order.id, { status: "failed" });
    return;
  }

  // Only act on a confirmed/authorized payment we haven't already settled.
  if (status !== "CONFIRMED" && status !== "AUTHORIZED") return;
  if (order.status === "confirmed") return;

  storage.updatePaymentOrder(order.id, {
    status: "confirmed",
    providerPaymentId: body.PaymentId != null ? String(body.PaymentId) : order.providerPaymentId,
  });

  // Activate the ride now that payment is confirmed, if not already started and
  // the bike is still rentable. If activation isn't possible the order stays
  // confirmed and an operator can reconcile manually.
  if (!order.bikeId || order.rideId) return;
  const started = storage.startRide({
    bikeId: order.bikeId,
    userId: order.userId,
    tariff: order.tariffId ?? "payg",
  });
  if ("error" in started) {
    log(`[tbank] ride not started for order ${orderId}: ${started.error}`, "tbank");
    return;
  }
  storage.updatePaymentOrder(order.id, { rideId: started.id });
}

// Build a masked PAN label from a T-Bank-provided masked pan. T-Bank already
// sends a masked value (e.g. "430000******0777"); we render the last 4 digits.
function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return last4 ? `•••• ${last4}` : "Карта";
}

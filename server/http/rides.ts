import type { Express, Request, Response } from "express";
import { storage, rideEvents } from "../storage";
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
import { sendToUserAsync } from "./../push";
import {
  riderId, isStaffSession, canManageRide, actorName, clientIp,
  requireRole, requireAuth, requireRoleWhenConfigured,
  otpLimiter, paymentLimiter,
} from "./context";

export function registerRideRoutes(app: Express): void {
  // -------------- Rides --------------
  app.get("/api/rides", async (req, res) => {
    const requested = (req.query.userId as string) ?? undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const staff = await isStaffSession(req);
    // An explicit userId filter may only target your own rides unless you are
    // staff — otherwise it leaks any rider's history (IDOR).
    if (requested !== undefined) {
      if (!staff && requested !== riderId(req)) {
        return res.status(403).json({ error: "Нет доступа" });
      }
      return res.json(await storage.listRides({ userId: requested, limit }));
    }
    // No filter: staff get the full operational list; everyone else is confined
    // to their own rides so an unfiltered call can't dump the whole table.
    if (staff) return res.json(await storage.listRides({ limit }));
    return res.json(await storage.listRides({ userId: riderId(req), limit }));
  });
  app.get("/api/rides/active", async (req, res) => {
    const ride = await storage.getActiveRide(riderId(req));
    res.json(ride ?? null);
  });
  // Server-Sent Events stream of the caller's active ride. Replaces the 4s
  // polling of /api/rides/active: the client opens ONE EventSource and the
  // server pushes a fresh snapshot only when this rider's ride actually
  // changes (start/point/end), driven by the in-process rideEvents bus.
  //
  // Why SSE (not WebSocket): the feed is one-way server→client, per-user (not a
  // shared broadcast), rides over plain HTTP with the session cookie, and the
  // browser's EventSource auto-reconnects on drop. No extra protocol upgrade,
  // no ws dependency.
  app.get("/api/rides/active/stream", async (req, res) => {
    const uid = riderId(req);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx) so events flush immediately.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    let closed = false;
    // Serialise pushes: an event that arrives while a DB read is in flight sets
    // a "dirty" flag instead of racing a second concurrent read; we re-read
    // once the current push finishes. Guarantees the last state always wins.
    let sending = false;
    let dirty = false;

    const push = async () => {
      if (closed) return;
      if (sending) { dirty = true; return; }
      sending = true;
      try {
        const ride = await storage.getActiveRide(uid);
        if (closed) return;
        res.write(`data: ${JSON.stringify(ride ?? null)}\n\n`);
      } catch {
        // A transient read error shouldn't kill the stream; the next event or
        // the client's reconnect will re-sync.
      } finally {
        sending = false;
        if (dirty && !closed) { dirty = false; void push(); }
      }
    };

    const onEvent = () => { void push(); };
    rideEvents.on(uid, onEvent);

    // Initial snapshot so a freshly-opened stream shows current state at once.
    void push();

    // Heartbeat comment keeps intermediaries from closing an idle connection
    // and lets us detect a dead socket. SSE comments (": ...") are ignored by
    // the EventSource client.
    const heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, 25000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      rideEvents.off(uid, onEvent);
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
  });
  app.post("/api/rides/start", async (req, res) => {
    const schema = z.object({ bikeId: z.string(), tariff: z.enum(["h1", "h2", "h3"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    // A blocked account may stay logged in but cannot start new rentals.
    const sessUser = req.session?.userId ? await storage.getUser(req.session.userId) : undefined;
    if (sessUser?.blockedAt) {
      return res.status(403).json({ error: "Аккаунт заблокирован. Обратитесь в поддержку." });
    }
    const r = await storage.startRide({ bikeId: parsed.data.bikeId, userId: riderId(req), tariff: parsed.data.tariff });
    if ("error" in r) return res.status(400).json(r);
    res.json(r);
  });
  app.post("/api/rides/:id/point", async (req, res) => {
    const schema = z.object({ x: z.number(), y: z.number() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    const ride = await storage.getRide(Number(req.params.id));
    if (!ride) return res.status(404).json({ error: "Поездка не активна" });
    if (!(await canManageRide(req, ride))) return res.status(403).json({ error: "Нет доступа" });
    const r = await storage.appendRidePoint(Number(req.params.id), parsed.data.x, parsed.data.y);
    if (!r) return res.status(404).json({ error: "Поездка не активна" });
    res.json(r);
  });
  app.post("/api/rides/:id/end", async (req, res) => {
    const ride = await storage.getRide(Number(req.params.id));
    if (!ride) return res.status(404).json({ error: "Поездка не активна" });
    if (!(await canManageRide(req, ride))) return res.status(403).json({ error: "Нет доступа" });
    const r = await storage.endRide(Number(req.params.id));
    if (!r) return res.status(404).json({ error: "Поездка не активна" });
    res.json(r);
  });

  // -------------- Admin rides --------------
  // Staff-only operational view of every ride with rider identity attached.
  // 401 unregistered, 403 registered-but-not-staff (mirrors /api/admin/*).
  app.get("/api/admin/rides", requireRole("operator", "admin"), async (req, res) => {
    const limit = req.query.limit ? Math.min(Number(req.query.limit) || 200, 1000) : 200;
    res.json(await storage.listAdminRides({ limit }));
  });
  // Manually finish any active ride. Reuses the shared endRide() (which settles
  // cost, frees the bike and charges the wallet) but, unlike the rider endpoint,
  // an operator may end a ride that isn't their own. 404 if not active.
  app.post("/api/admin/rides/:id/end", requireRole("operator", "admin"), async (req, res) => {
    const rideId = Number(req.params.id);
    const before = await storage.getRide(rideId);
    const r = await storage.endRide(rideId);
    if (!r) return res.status(404).json({ error: "Поездка не активна" });
    // Уведомляем клиента — его поездку завершил оператор.
    if (before?.userId) {
      sendToUserAsync(before.userId, {
        title: "Поездка завершена",
        body: "Оператор завершил вашу поездку. Подробности в истории.",
        url: "/rides",
        tag: `ride:${rideId}`,
        data: { kind: "ride-ended-by-operator", rideId },
      });
    }
    res.json(r);
  });
}

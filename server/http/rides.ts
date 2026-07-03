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

export function registerRideRoutes(app: Express): void {
  // -------------- Rides --------------
  app.get("/api/rides", (req, res) => {
    const requested = (req.query.userId as string) ?? undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const staff = isStaffSession(req);
    // An explicit userId filter may only target your own rides unless you are
    // staff — otherwise it leaks any rider's history (IDOR).
    if (requested !== undefined) {
      if (!staff && requested !== riderId(req)) {
        return res.status(403).json({ error: "Нет доступа" });
      }
      return res.json(storage.listRides({ userId: requested, limit }));
    }
    // No filter: staff get the full operational list; everyone else is confined
    // to their own rides so an unfiltered call can't dump the whole table.
    if (staff) return res.json(storage.listRides({ limit }));
    return res.json(storage.listRides({ userId: riderId(req), limit }));
  });
  app.get("/api/rides/active", (req, res) => {
    const ride = storage.getActiveRide(riderId(req));
    res.json(ride ?? null);
  });
  app.post("/api/rides/start", (req, res) => {
    const schema = z.object({ bikeId: z.string(), tariff: z.enum(["h1", "h2", "h3"]) });
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
    const ride = storage.getRide(Number(req.params.id));
    if (!ride) return res.status(404).json({ error: "Поездка не активна" });
    if (!canManageRide(req, ride)) return res.status(403).json({ error: "Нет доступа" });
    const r = storage.appendRidePoint(Number(req.params.id), parsed.data.x, parsed.data.y);
    if (!r) return res.status(404).json({ error: "Поездка не активна" });
    res.json(r);
  });
  app.post("/api/rides/:id/end", (req, res) => {
    const ride = storage.getRide(Number(req.params.id));
    if (!ride) return res.status(404).json({ error: "Поездка не активна" });
    if (!canManageRide(req, ride)) return res.status(403).json({ error: "Нет доступа" });
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
}

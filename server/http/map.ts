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

export function registerMapRoutes(app: Express): void {
  // -------------- Map objects (operator-drawn routes/zones) --------------
  // Public read returns only active objects so inactive ones never render on the
  // customer map. The editor reads /api/admin/map-objects for the full list.
  app.get("/api/map-objects", async (_req, res) => res.json(await storage.listMapObjects({ activeOnly: true })));
  app.get("/api/admin/map-objects", requireRoleWhenConfigured(), async (_req, res) =>
    res.json(await storage.listMapObjects()),
  );
  app.post("/api/map-objects", requireRoleWhenConfigured(), async (req, res) => {
    const parsed = insertMapObjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.json(await storage.createMapObject(parsed.data));
  });
  app.patch("/api/map-objects/:id", requireRoleWhenConfigured(), async (req, res) => {
    const parsed = updateMapObjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    const obj = await storage.updateMapObject(Number(req.params.id), parsed.data);
    if (!obj) return res.status(404).json({ error: "Объект не найден" });
    res.json(obj);
  });
  app.delete("/api/map-objects/:id", requireRoleWhenConfigured(), async (req, res) => {
    const ok = await storage.deleteMapObject(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "Объект не найден" });
    res.json({ ok: true });
  });

  // -------------- Analytics --------------
  app.get("/api/analytics", async (_req, res) => res.json(await storage.analytics()));

  // Period-scoped analytics for the admin "Аналитика v1" page. Staff-only.
  // `from`/`to` are unix-ms bounds (inclusive); defaults to the last 30 days.
  app.get("/api/admin/analytics", requireRole("operator", "admin"), async (req, res) => {
    const now = Date.now();
    const parseTs = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    const from = parseTs(req.query.from, now - 30 * 24 * 60 * 60 * 1000);
    const to = parseTs(req.query.to, now);
    if (from > to) return res.status(400).json({ error: "Некорректный диапазон дат" });
    res.json(await storage.adminAnalytics({ from, to }));
  });
}

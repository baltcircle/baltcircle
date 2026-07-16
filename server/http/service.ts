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
  otpLimiter, paymentLimiter, parsePageParams,
} from "./context";

export function registerServiceTicketRoutes(app: Express): void {
  const requireServiceStaff = requireRoleWhenConfigured("mechanic", "operator", "admin");
  // -------------- Service / maintenance tickets --------------
  // List is open (operator UI reads it freely); all mutations are staff-gated
  // when ADMIN_PHONE_NUMBERS is configured. Service tickets are the mechanic's
  // core surface, so mechanic/operator/admin may create, update and comment.
  app.get("/api/tickets", async (req, res) => {
    const page = parsePageParams(req);
    res.setHeader("X-Total-Count", String(await storage.countTickets()));
    res.json(await storage.listTickets(page));
  });
  app.get("/api/tickets/:id", async (req, res) => {
    const t = await storage.getTicket(Number(req.params.id));
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    res.json(t);
  });
  app.post("/api/tickets", requireServiceStaff, async (req, res) => {
    const parsed = createTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Проверьте данные" });
    }
    res.status(201).json(await storage.createTicket(parsed.data));
  });
  app.patch("/api/tickets/:id", requireServiceStaff, async (req, res) => {
    const parsed = updateTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Проверьте данные" });
    }
    const t = await storage.updateTicket(Number(req.params.id), parsed.data, (await actorName(req)));
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    res.json(t);
  });
  app.post("/api/tickets/:id/comments", requireServiceStaff, async (req, res) => {
    const parsed = addTicketCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Проверьте данные" });
    }
    const t = await storage.addTicketComment(Number(req.params.id), (await actorName(req)), parsed.data.body);
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    res.status(201).json(t);
  });
}

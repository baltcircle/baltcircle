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

export function registerAdminUserRoutes(app: Express): void {
  // -------------- Admin: user management --------------
  // All endpoints require an operator/admin session (401 unregistered, 403
  // registered-but-not-staff). Granting/revoking the admin role additionally
  // requires the caller to be an admin — operators may manage rider/operator
  // roles but cannot create or remove admins.
  app.get("/api/admin/users", requireRole("operator", "admin"), async (req, res) => {
    const page = parsePageParams(req);
    res.setHeader("X-Total-Count", String(await storage.countUsers()));
    res.json(await storage.listUsers(page));
  });

  app.patch("/api/admin/users/:id/role", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminSetRoleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });

    const targetId = String(req.params.id);
    const actor = (await storage.getUser(req.session!.userId!))!;
    const target = await storage.getUser(targetId);
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
    // Admins cannot change each other's roles.
    if (actor.id !== target.id && target.role === "admin") {
      return res.status(403).json({ error: "Нельзя изменить роль другого администратора" });
    }

    const result = await storage.setUserRole(targetId, parsed.data.role);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.user);
  });

  app.patch("/api/admin/users/:id/status", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminSetBlockedSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });

    const targetId = String(req.params.id);
    const actor = (await storage.getUser(req.session!.userId!))!;
    const target = await storage.getUser(targetId);
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });

    if (actor.id === target.id) {
      return res.status(400).json({ error: "Нельзя заблокировать самого себя" });
    }
    // Admins cannot block each other.
    if (target.role === "admin") {
      return res.status(403).json({ error: "Нельзя заблокировать другого администратора" });
    }

    const result = await storage.setUserBlocked(targetId, parsed.data.blocked, parsed.data.reason);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.user);
  });
}

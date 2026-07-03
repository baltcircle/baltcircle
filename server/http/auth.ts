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

export function registerAuthRoutes(app: Express): void {
  // -------------- Rider registration (SMS OTP) --------------
  // Step 1: rider submits name + phone + consent. We generate a code, persist
  // its hash, and dispatch it by SMS. No session is created yet.
  app.post("/api/auth/otp/start", otpLimiter, async (req, res) => {
    const parsed = otpStartSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.startOtp({ name: parsed.data.name, phone: parsed.data.phone });
    if ("error" in result) {
      const status = result.retryAfterSec ? 429 : 400;
      return res.status(status).json(result);
    }
    try {
      const sent = await sendOtpSms(result.phone, result.code);
      // Persist the provider's sending id/status so staff can later query the
      // provider's delivery status for this phone. Non-secret diagnostics only.
      await storage.recordOtpSend({
        phone: result.phone,
        provider: sent.provider,
        providerMessageId: sent.providerMessageId,
        providerStatus: sent.providerStatus,
      });
      // In dev fallback (no SMS provider configured) we echo the code so the
      // flow is testable locally. In production this is always undefined.
      res.json({
        phone: result.phone,
        resendInSec: result.resendInSec,
        ...(sent.providerStatus ? { providerStatus: sent.providerStatus } : {}),
        ...(sent.devEcho ? { devCode: result.code } : {}),
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Не удалось отправить SMS. Попробуйте позже." });
    }
  });

  // Step 2: rider submits the code. On success we create/activate the rider and
  // bind the session, allowing rental/scan.
  app.post("/api/auth/otp/verify", otpLimiter, async (req, res) => {
    const parsed = otpVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.verifyOtp({
      phone: parsed.data.phone,
      code: parsed.data.code,
      consentIp: clientIp(req),
    });
    if ("error" in result) return res.status(400).json(result);
    req.session.userId = result.user.id;
    res.status(201).json(result.user);
  });

  // Public probe so the client can tell whether a real SMS provider is wired up.
  // Never exposes the token — just the provider name and a configured flag.
  app.get("/api/sms/config", async (_req, res) => {
    res.json({ provider: smsProvider() || "(none)", configured: getSmsDiagnostics().configured });
  });

  // Admin-only SMS diagnostics. Returns ONLY non-secret metadata: provider,
  // configured flag, token LENGTH (never the token), sender and the API base.
  // Lets staff confirm the SigmaSMS wiring without ever seeing the secret.
  app.get("/api/sms/diagnostics", requireRole("admin"), async (_req, res) => {
    res.json(getSmsDiagnostics());
  });


  // Admin-only OTP delivery diagnostics for a phone. Returns the stored provider
  // metadata for the last OTP send (provider, sending id, status, error, and the
  // OTP request timestamps) — never the code or its hash. When a SigmaSMS sending
  // id is on file, this also queries the provider's status API and persists the
  // refreshed status so repeat checks reflect the latest delivery state.
  // Usage: GET /api/sms/otp-status?phone=+79991234567
  app.get("/api/sms/otp-status", requireRole("admin"), async (req, res) => {
    const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : "";
    if (!phone) return res.status(400).json({ error: "Укажите параметр phone" });

    const row = await storage.getLastOtpSend(phone);
    if (!row) {
      return res.status(404).json({ error: "По этому номеру нет записей об отправке кода" });
    }

    // If we have a SigmaSMS sending id, refresh the delivery status from the
    // provider and persist it. A lookup failure is reported but does not fail the
    // endpoint — the stored snapshot is still returned.
    let providerLookup: { httpStatus: number; found: boolean; status?: string; error?: string } | undefined;
    if (row.provider === "sigmasms" && smsProvider() === "sigmasms" && row.providerMessageId) {
      try {
        const live = await getSigmaSmsSendingStatus(row.providerMessageId);
        providerLookup = live;
        await storage.updateOtpProviderStatus({
          phone,
          providerStatus: live.status ?? row.providerStatus ?? undefined,
          providerError: live.error ?? undefined,
        });
      } catch (err: any) {
        providerLookup = { httpStatus: 0, found: false, error: err?.message ?? "lookup failed" };
      }
    }

    // Re-read so the response reflects any refresh we just persisted.
    const latest = await storage.getLastOtpSend(phone) ?? row;
    res.json({
      phone: latest.phone,
      provider: latest.provider,
      providerMessageId: latest.providerMessageId,
      providerStatus: latest.providerStatus,
      providerError: latest.providerError,
      consumed: latest.consumed,
      createdAt: latest.lastSentAt,
      checkedAt: latest.providerCheckedAt,
      ...(providerLookup ? { providerLookup } : {}),
    });
  });

  app.get("/api/users/current", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.json(null);
    const user = await storage.getUser(id);
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
  app.patch("/api/users/me", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.updateProfile(id, parsed.data);
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
    const result = await storage.startPhoneChange({ userId: id, phone: parsed.data.phone });
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

  app.post("/api/users/me/phone/verify", async (req, res) => {
    const id = req.session?.userId;
    if (!id) return res.status(401).json({ error: "Требуется вход" });
    const parsed = phoneChangeVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.verifyPhoneChange({ userId: id, code: parsed.data.code });
    if ("error" in result) return res.status(400).json(result);
    res.json(result.user);
  });
}

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
import { readIdempotencyKey } from "./payments";

export function registerWalletRoutes(app: Express): void {
  // -------------- Wallet / Payments --------------
  app.get("/api/wallet", requireAuth, async (req, res) => res.json(await storage.getWallet(riderId(req))));
  // SECURITY (audit CRITICAL #1): this used to credit the wallet directly
  // from a client-supplied `amount` with NO payment verification whatsoever
  // — any authenticated rider could mint unlimited balance with a single
  // request. The real, payment-verified top-up flow now lives at
  // POST /api/payments/tbank/wallet/init (server/http/payments.ts): the
  // rider pays on T-Bank's hosted form and the balance is credited only once
  // the signed notification webhook confirms the charge
  // (handleWalletTopupNotification in server/payments/tbank-handlers.ts).
  //
  // This path is kept ONLY as a fixture for local dev / smoke tests that need
  // to seed a wallet balance without exercising real payments. It is
  // double-gated so it can NEVER run in production even if NODE_ENV is
  // misconfigured: a live T-Bank terminal is always configured in real
  // production, and isTbankConfigured() being true alone is enough to disable
  // it, on top of the explicit NODE_ENV check.
  app.post("/api/wallet/dev-credit", requireAuth, async (req, res) => {
    if (process.env.NODE_ENV === "production" || isTbankConfigured()) {
      return res.status(404).json({ error: "Not found" });
    }
    const schema = z.object({ amount: z.number().positive().max(50000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.json(await storage.topUp(riderId(req), Math.round(parsed.data.amount * 100)));
  });
  // Audit MEDIUM: this used to have no idempotency protection — a retried
  // request (double-click, network drop + resend) would re-run the debit and
  // charge the rider twice for the same tariff. Same Idempotency-Key pattern
  // as /api/payments/tbank/ride/init (audit HIGH #2): the key is required and
  // storage.purchaseTariff atomically gates the debit on it, so a replay with
  // the same key returns the original result instead of debiting again.
  app.post("/api/wallet/tariff", requireAuth, async (req, res) => {
    const idem = readIdempotencyKey(req);
    if ("error" in idem) return res.status(400).json({ error: idem.error });

    const schema = z.object({
      tariff: z.enum(["h1", "h2", "h3"]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    // Look up authoritative price/duration server-side; never trust client-supplied values
    const tariffDef = TARIFFS.find((t) => t.id === parsed.data.tariff);
    if (!tariffDef) return res.status(400).json({ error: "Unknown tariff" });
    const durationMs = tariffDef.durationHours * 60 * 60 * 1000;
    const priceKopecks = tariffPriceKopecks(tariffDef);
    try {
      res.json(await storage.purchaseTariff(riderId(req), parsed.data.tariff, priceKopecks, durationMs, idem.key));
    } catch (err) {
      // purchaseTariff throws a plain Error with a rider-facing message for the
      // one expected business failure (insufficient balance); anything else is
      // an infrastructure error and should surface as a 500 via the default
      // error handler, not be swallowed here.
      if (err instanceof Error && err.message === "Недостаточно средств на балансе") {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  });
  app.get("/api/payments", requireAuth, async (req, res) => res.json(await storage.listPayments(riderId(req))));
}

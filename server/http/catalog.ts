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

export function registerCatalogRoutes(app: Express): void {
  // -------------- Bikes / Parkings / Zones --------------
  // Public read: archived bikes are excluded so they never reach the map or
  // rental selection. (The admin fleet page uses /api/admin/bikes for the full
  // list including archived.)
  app.get("/api/bikes", async (_req, res) => res.json(await storage.listBikes()));
  app.get("/api/bikes/:id", async (req, res) => {
    const b = await storage.getBike(req.params.id);
    if (!b) return res.status(404).json({ error: "Велосипед не найден" });
    res.json(b);
  });
  // NOTE: there is intentionally no public PATCH /api/bikes/:id. Bike mutations
  // go through the staff-guarded PATCH /api/admin/bikes/:id (validated +
  // role-checked). An unguarded public PATCH passing req.body straight to
  // updateBike was an unauthenticated mass-assignment hole and has been removed.
  // Public read: only active, non-archived parking points reach the customer
  // app. The admin page uses /api/admin/parkings for the full list.
  app.get("/api/parkings", async (_req, res) => res.json(await storage.listParkings()));

  // -------------- Admin: parking management --------------
  // Staff-only CRUD over parking points. The list includes inactive + archived
  // points so operators can see/restore them; the public /api/parkings never does.
  app.get("/api/admin/parkings", requireRole("operator", "admin"), async (_req, res) => {
    res.json(await storage.listParkings({ includeInactive: true, includeArchived: true }));
  });
  app.post("/api/admin/parkings", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminCreateParkingSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.createParking(parsed.data);
    if ("error" in result) return res.status(409).json(result);
    res.status(201).json(result.parking);
  });
  app.patch("/api/admin/parkings/:id", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminUpdateParkingSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.updateParking(String(req.params.id), parsed.data);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  app.post("/api/admin/parkings/:id/archive", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.archiveParking(String(req.params.id));
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  // Restore returns an archived point as *inactive* so it never re-appears on
  // the public map until an operator activates it; it shows muted on admin maps.
  app.post("/api/admin/parkings/:id/restore", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.restoreParking(String(req.params.id));
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  app.delete("/api/admin/parkings/:id", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.deleteParking(String(req.params.id));
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
  app.get("/api/admin/bikes", requireRole("mechanic", "operator", "admin"), async (_req, res) => {
    res.json(await storage.listBikes({ includeArchived: true }));
  });
  app.post("/api/admin/bikes", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminCreateBikeSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.createBike(parsed.data);
    if ("error" in result) return res.status(409).json(result);
    res.status(201).json(result.bike);
  });
  app.patch("/api/admin/bikes/:id", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminUpdateBikeSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.adminUpdateBike(String(req.params.id), parsed.data);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.bike);
  });
  app.post("/api/admin/bikes/:id/archive", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.archiveBike(String(req.params.id));
    if ("error" in result) {
      const status = (result.error ?? "").includes("не найден") ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result.bike);
  });
  app.delete("/api/admin/bikes/:id", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.deleteBike(String(req.params.id));
    if ("error" in result) {
      // Bike kept but archived (had ride history) → 409 with the archived row.
      if (result.archived) return res.status(409).json(result);
      const status = (result.error ?? "").includes("не найден") ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  });
  app.get("/api/zones", async (_req, res) => res.json(await storage.listZones()));
}

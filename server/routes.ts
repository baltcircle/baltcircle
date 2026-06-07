import type { Express, Request, Response, NextFunction } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage } from "./storage";
import { z } from "zod";
import { TARIFFS } from "@shared/geo";
import {
  insertMapObjectSchema, otpStartSchema, otpVerifySchema, updateProfileSchema,
} from "@shared/schema";
import type { UserRole } from "@shared/schema";
import { sendOtpSms } from "./sms";

// Resolve the active rider id. A registered rider has their user id stored in
// the session; everyone else shares the seeded "demo" account so the public
// MVP (map, demo rides, analytics) keeps working without registration.
function riderId(req: Request): string {
  return req.session?.userId ?? "demo";
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

// Admin guard for operator-facing mutation endpoints. To avoid locking the
// operator UI (map editor, tickets) out of local dev — where no admin exists —
// the guard is only enforced when ADMIN_PHONE_NUMBERS is configured. With the
// env set (staging/prod) it requires an operator/admin session; without it the
// endpoints stay open so the MVP map editor remains testable.
function requireAdminWhenConfigured() {
  const guard = requireRole("operator", "admin");
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
  // -------------- Bikes / Parkings / Zones --------------
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
  app.get("/api/parkings", (_req, res) => res.json(storage.listParkings()));
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

  // -------------- Maintenance tickets --------------
  app.get("/api/tickets", (_req, res) => res.json(storage.listTickets()));
  app.post("/api/tickets", (req, res) => {
    const schema = z.object({
      bikeId: z.string(),
      kind: z.string(),
      message: z.string().min(2),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.json(storage.createTicket(parsed.data));
  });
  app.patch("/api/tickets/:id", requireAdminWhenConfigured(), (req, res) => {
    const schema = z.object({ status: z.enum(["open", "in_progress", "resolved"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    const t = storage.updateTicketStatus(Number(req.params.id), parsed.data.status);
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    res.json(t);
  });

  // -------------- Map objects (operator-drawn routes/zones) --------------
  app.get("/api/map-objects", (_req, res) => res.json(storage.listMapObjects()));
  app.post("/api/map-objects", requireAdminWhenConfigured(), (req, res) => {
    const parsed = insertMapObjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.json(storage.createMapObject(parsed.data));
  });
  app.delete("/api/map-objects/:id", requireAdminWhenConfigured(), (req, res) => {
    const ok = storage.deleteMapObject(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "Объект не найден" });
    res.json({ ok: true });
  });

  // -------------- Analytics --------------
  app.get("/api/analytics", (_req, res) => res.json(storage.analytics()));

  return httpServer;
}

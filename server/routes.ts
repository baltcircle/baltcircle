import type { Express } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { storage } from "./storage";
import { z } from "zod";
import { TARIFFS } from "@shared/geo";
import { insertMapObjectSchema } from "@shared/schema";

const USER_ID = "demo";

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
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
  app.get("/api/rides/active", (_req, res) => {
    const ride = storage.getActiveRide(USER_ID);
    res.json(ride ?? null);
  });
  app.post("/api/rides/start", (req, res) => {
    const schema = z.object({ bikeId: z.string(), tariff: z.string().default("payg") });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    const r = storage.startRide({ bikeId: parsed.data.bikeId, userId: USER_ID, tariff: parsed.data.tariff });
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
  app.get("/api/wallet", (_req, res) => res.json(storage.getWallet(USER_ID)));
  app.post("/api/wallet/topup", (req, res) => {
    const schema = z.object({ amount: z.number().positive().max(50000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.json(storage.topUp(USER_ID, parsed.data.amount));
  });
  app.post("/api/wallet/tariff", (req, res) => {
    const schema = z.object({
      tariff: z.enum(["payg", "day", "month"]),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    // Look up authoritative price/duration server-side; never trust client-supplied values
    const tariffDef = TARIFFS.find((t) => t.id === parsed.data.tariff);
    if (!tariffDef) return res.status(400).json({ error: "Unknown tariff" });
    const durationMs = parsed.data.tariff === "day" ? 24 * 60 * 60 * 1000
      : parsed.data.tariff === "month" ? 30 * 24 * 60 * 60 * 1000
      : 0;
    const w = storage.getWallet(USER_ID);
    if (w.balance < tariffDef.price) {
      return res.status(400).json({ error: "Недостаточно средств на балансе" });
    }
    res.json(storage.purchaseTariff(USER_ID, parsed.data.tariff, tariffDef.price, durationMs));
  });
  app.get("/api/payments", (_req, res) => res.json(storage.listPayments(USER_ID)));

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
  app.patch("/api/tickets/:id", (req, res) => {
    const schema = z.object({ status: z.enum(["open", "in_progress", "resolved"]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    const t = storage.updateTicketStatus(Number(req.params.id), parsed.data.status);
    if (!t) return res.status(404).json({ error: "Заявка не найдена" });
    res.json(t);
  });

  // -------------- Map objects (operator-drawn routes/zones) --------------
  app.get("/api/map-objects", (_req, res) => res.json(storage.listMapObjects()));
  app.post("/api/map-objects", (req, res) => {
    const parsed = insertMapObjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Bad request" });
    res.json(storage.createMapObject(parsed.data));
  });
  app.delete("/api/map-objects/:id", (req, res) => {
    const ok = storage.deleteMapObject(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "Объект не найден" });
    res.json({ ok: true });
  });

  // -------------- Analytics --------------
  app.get("/api/analytics", (_req, res) => res.json(storage.analytics()));

  return httpServer;
}

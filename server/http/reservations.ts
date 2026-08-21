import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, riderId, reservationLimiter } from "./context";

const createReservationSchema = z.object({
  bikeId: z.string().min(1),
});

export function registerReservationRoutes(app: Express): void {
  // Booking is private-rider functionality (ties up a real bike for the
  // caller specifically) — always requireAuth, never fall back to the
  // shared "demo" rider like the public map/catalog surfaces do.
  app.post("/api/reservations", reservationLimiter, requireAuth, async (req, res) => {
    const parsed = createReservationSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.createReservation({ bikeId: parsed.data.bikeId, userId: riderId(req) });
    if ("error" in result) return res.status(409).json({ error: result.error });
    return res.status(201).json(result.reservation);
  });

  app.post("/api/reservations/:id/cancel", reservationLimiter, requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Некорректный id брони" });
    const result = await storage.cancelReservation(id, riderId(req));
    if ("error" in result) return res.status(409).json({ error: result.error });
    return res.json({ ok: true });
  });

  app.get("/api/reservations/active", requireAuth, async (req, res) => {
    const reservation = await storage.getActiveReservationForUser(riderId(req));
    return res.json(reservation ?? null);
  });
}

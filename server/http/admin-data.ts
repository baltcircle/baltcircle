import type { Express } from "express";
import { parseTimestamp } from "@shared/admin-data";
import { activeAdminRides, feedbackPage, ridesPage, rideStats, usersPage, staffUsers } from "../storage/admin-read";
import { requireRole } from "./context";

export function registerAdminDataRoutes(app: Express) {
  const staff = requireRole("operator", "admin");
  app.get("/api/admin/rides/page", staff, async (req, res) => res.json(await ridesPage(req.query)));
  app.get("/api/admin/rides/active", staff, async (_req, res) => res.json(await activeAdminRides()));
  app.get("/api/admin/users/page", staff, async (req, res) => res.json(await usersPage(req.query)));
  app.get("/api/admin/users/staff", staff, async (_req, res) => res.json(await staffUsers()));
  app.get("/api/admin/feedback/page", staff, async (req, res) => res.json(await feedbackPage(req.query)));
  app.get("/api/admin/ride-stats", staff, async (req, res) => {
    const now = Date.now();
    const from = parseTimestamp(req.query.from, now - 24 * 60 * 60 * 1000);
    const to = parseTimestamp(req.query.to, now);
    if (from > to) return res.status(400).json({ error: "Некорректный диапазон дат" });
    res.json(await rideStats(from, to));
  });
}

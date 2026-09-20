import type { Express } from "express";
import { requireAuth, riderId } from "./context";
import { riderHistory, riderStats } from "../storage/rider-read";
import { rideHistoryCursor } from "@shared/rider-data";

export function registerRiderDataRoutes(app: Express) {
  app.get("/api/rider/history", requireAuth, async (req, res) => {
    const before = rideHistoryCursor(req.query.before);
    if (req.query.before !== undefined && before === undefined) return res.status(400).json({ error: "Некорректный курсор" });
    res.json(await riderHistory(riderId(req), before));
  });
  app.get("/api/rider/stats", requireAuth, async (req, res) => {
    res.json(await riderStats(riderId(req)));
  });
}

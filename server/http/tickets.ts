import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { createSupportTicketSchema, updateSupportTicketSchema } from "@shared/schema";
import type { PaymentMethod, PaymentOrder, Ride } from "@shared/schema";
import type { TbankConfig } from "./../tbank";
import { riderId, requireRole, requireAuth } from "./context";

export function registerSupportTicketRoutes(app: Express): void {
  // -------------- Support tickets (rider help requests) --------------
  app.get("/api/support/tickets", requireAuth, async (req, res) => {
    res.json(await storage.listSupportTickets(riderId(req)));
  });
  app.post("/api/support/tickets", requireAuth, async (req, res) => {
    const parsed = createSupportTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    res.status(201).json(await storage.createSupportTicket({ userId: riderId(req), ...parsed.data }));
  });

  // -------------- Staff inbox: all rider support requests --------------
  // Operators and admins can see every rider help request and mark them as
  // resolved once handled. No comment thread — the MVP handles replies out of
  // band; this endpoint only manages the status flag.
  app.get("/api/admin/support/tickets", requireRole("operator", "admin"), async (_req, res) => {
    res.json(await storage.listAllSupportTickets());
  });

  app.patch("/api/admin/support/tickets/:id", requireRole("operator", "admin"), async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Неверный id заявки" });
    const parsed = updateSupportTicketSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const updated = await storage.updateSupportTicket(id, parsed.data);
    if (!updated) return res.status(404).json({ error: "Заявка не найдена" });
    res.json(updated);
  });
}

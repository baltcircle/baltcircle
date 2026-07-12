// Web Push subscription endpoints.
//
// Клиент:
//   1) GET  /api/push/vapid-key       — public VAPID key (для PushManager.subscribe)
//   2) POST /api/push/subscribe       — сохранить подписку (endpoint + keys)
//   3) POST /api/push/unsubscribe     — удалить подписку по endpoint
//
// Все, кроме vapid-key, требуют авторизации.

import type { Express, Request, Response } from "express";
import { pushSubscribeSchema, pushUnsubscribeSchema } from "@shared/schema";
import { requireAuth } from "./context";
import { getVapidPublicKey, isPushConfigured, removeSubscription, upsertSubscription } from "../push";

export function registerPushRoutes(app: Express): void {
  // Publish VAPID public key; клиент передаст его в PushManager.subscribe.
  app.get("/api/push/vapid-key", (_req: Request, res: Response) => {
    const key = getVapidPublicKey();
    if (!key || !isPushConfigured()) {
      return res.status(503).json({ error: "push_not_configured" });
    }
    res.json({ publicKey: key });
  });

  app.post("/api/push/subscribe", requireAuth, async (req: Request, res: Response) => {
    if (!isPushConfigured()) return res.status(503).json({ error: "push_not_configured" });
    const parsed = pushSubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const userId = req.session!.userId!;
    const uaHeader = req.header("user-agent")?.slice(0, 500);
    await upsertSubscription({
      userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      authKey: parsed.data.keys.auth,
      userAgent: parsed.data.userAgent ?? uaHeader,
    });
    res.json({ ok: true });
  });

  app.post("/api/push/unsubscribe", requireAuth, async (req: Request, res: Response) => {
    const parsed = pushUnsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body" });
    }
    const userId = req.session!.userId!;
    await removeSubscription(userId, parsed.data.endpoint);
    res.json({ ok: true });
  });
}

import type { Express, Request, Response } from "express";
import type { CookieOptions } from "express";
import { storage } from "../storage";
import { unlinkPaymentMethodForUser } from "./payments";
import { clientIp } from "./context";

const sessionCookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

/**
 * Erases the server-side session and expires the matching browser cookie.
 * Destroying the session rather than only clearing userId also removes OAuth
 * CSRF state and any future session-scoped data.
 */
export function destroySession(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const clearCookie = () => res.clearCookie("bc.sid", sessionCookieOptions);
    if (!req.session) {
      clearCookie();
      resolve();
      return;
    }
    req.session.destroy((err) => {
      clearCookie();
      if (err) reject(err);
      else resolve();
    });
  });
}

function deletionError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function registerAccountRoutes(app: Express): void {
  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      await destroySession(req, res);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/account", async (req, res, next) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: "Требуется вход" });

      const user = await storage.getUser(userId);
      if (!user) {
        await destroySession(req, res);
        return res.status(401).json({ error: "Требуется вход" });
      }

      // This early check avoids any external unlinks when deletion is already
      // impossible. DatabaseStorage checks it again in its final transaction.
      if ((await storage.getActiveRides(userId)).length > 0) {
        return res.status(409).json({ error: "Сначала завершите активную поездку." });
      }

      const methods = await storage.listPaymentMethods(userId);
      // Do not race an in-flight AddCard/AddAccountQr flow. A pending binding
      // may still receive an acquirer webhook, so the rider must first wait for
      // it to finish or cancel it from payment methods.
      if (methods.some((method) => method.status === "pending")) {
        return res.status(409).json({
          error: "Дождитесь завершения или отмените привязку карты/СБП перед удалением аккаунта.",
        });
      }

      for (const method of methods) {
        // Uses the exact same unlink path as the “Отвязать карту” control:
        // provider card revocation first, then local token/metadata removal.
        const result = await unlinkPaymentMethodForUser(userId, method, clientIp(req));
        if (!result.ok) {
          throw deletionError(result.error, result.status);
        }
      }

      const deleted = await storage.deleteAccount(userId);
      if ("error" in deleted) {
        if (deleted.error === "active_ride") {
          return res.status(409).json({ error: "Сначала завершите активную поездку." });
        }
        await destroySession(req, res);
        return res.status(401).json({ error: "Требуется вход" });
      }

      await destroySession(req, res);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
}

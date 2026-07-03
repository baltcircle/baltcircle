import type { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { storage } from "../storage";
import type { UserRole, Ride } from "@shared/schema";

// Shared HTTP context for the domain route modules. These helpers were
// module-level in routes.ts before the god-file was split into per-domain
// registrars; they are exported here so every domain module (auth, payments,
// wallet, rides, catalog, admin, tickets, tiles) shares one implementation.

// Resolve the active rider id. A registered rider has their user id stored in
// the session; everyone else shares the seeded "demo" account so the public
// MVP (map, demo rides, analytics) keeps working without registration.
export function riderId(req: Request): string {
  return req.session?.userId ?? "demo";
}

// True when the session belongs to operator/admin staff. Staff may read/manage
// any rider's rides; ordinary riders are confined to their own.
export async function isStaffSession(req: Request): Promise<boolean> {
  const id = req.session?.userId;
  const user = id ? await storage.getUser(id) : undefined;
  return user?.role === "operator" || user?.role === "admin";
}

// Ownership guard for a ride: the acting rider owns it, or the caller is staff.
// Uses riderId() (which falls back to "demo") so the public demo flow — where an
// unregistered rider owns "demo" rides — keeps working.
export async function canManageRide(req: Request, ride: Ride): Promise<boolean> {
  return ride.userId === riderId(req) || (await isStaffSession(req));
}

// Display name of the acting staff member for ticket history. Falls back to a
// generic label when no session user is resolvable (local dev with guard off).
export async function actorName(req: Request): Promise<string> {
  const id = req.session?.userId;
  const user = id ? await storage.getUser(id) : undefined;
  return user?.name ?? "Оператор";
}

// Best-effort client IP for consent auditing. Honours the first X-Forwarded-For
// hop (we set `trust proxy` in index.ts) and falls back to the socket address.
export function clientIp(req: Request): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || undefined;
}

// Guard for operator/admin-only endpoints. Resolves the session user and checks
// the effective role (which honours the ADMIN_PHONE_NUMBERS env override).
// 401 when not registered, 403 when registered but not privileged.
export function requireRole(...roles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const id = req.session?.userId;
    const user = id ? await storage.getUser(id) : undefined;
    if (!user) return res.status(401).json({ error: "Требуется вход" });
    if (!roles.includes(user.role as UserRole)) {
      return res.status(403).json({ error: "Нет доступа" });
    }
    next();
  };
}

// Guard for a registered rider's PRIVATE data (wallet, payments, saved cards,
// support tickets). Without this the riderId() "demo" fallback would silently
// route an anonymous caller into the shared demo account — letting them read
// and mutate the demo rider's balance, cards and tickets (IDOR / privacy leak).
// Public surfaces (map, demo rides, analytics) intentionally keep the fallback.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const id = req.session?.userId;
  const user = id ? await storage.getUser(id) : undefined;
  if (!user) return res.status(401).json({ error: "Требуется вход" });
  next();
}

// Guard for operator-facing mutation endpoints (map editor, tickets, bikes,
// parkings). Enforcement rules:
//   - In PRODUCTION the role check is ALWAYS enforced, even if
//     ADMIN_PHONE_NUMBERS is unset. A missing/misconfigured env var must never
//     silently open staff mutations to the public.
//   - Outside production the guard is enforced only when ADMIN_PHONE_NUMBERS is
//     set, so local dev — where no admin account exists — can still exercise
//     the operator UI without being locked out.
// Defaults to operator/admin; service endpoints pass "mechanic" too so service
// staff can work tickets.
export function requireRoleWhenConfigured(...roles: UserRole[]) {
  const guard = requireRole(...(roles.length ? roles : (["operator", "admin"] as UserRole[])));
  return (req: Request, res: Response, next: NextFunction) => {
    const isProd = process.env.NODE_ENV === "production";
    if (!isProd && !process.env.ADMIN_PHONE_NUMBERS) return next();
    return guard(req, res, next);
  };
}

// --- Rate limiters ---------------------------------------------------------
// We sit behind nginx with `trust proxy` set, so the limiter keys on the real
// client IP (first X-Forwarded-For hop). Standard headers on, legacy off.
//
// OTP start dispatches a REAL SMS (direct cost) and OTP verify is a code
// guess — both are prime abuse targets, so they get a tight limit. Payment
// init endpoints redirect to the acquirer; abuse there spams order creation,
// so they get a looser limit. The T-Bank notification webhook is intentionally
// NOT limited: it is server-to-server from the bank and dropping it would lose
// payment confirmations.
// Set DISABLE_RATE_LIMIT=1 to bypass IP rate limiting. Used only by smoke tests,
// which drive many registrations/payments from a single IP and would otherwise
// trip the production limits. Never set in production.
const rateLimitDisabled = () => process.env.DISABLE_RATE_LIMIT === "1";
export const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // 5 OTP requests per IP per window (start + verify share this)
  standardHeaders: true,
  legacyHeaders: false,
  skip: rateLimitDisabled,
  message: { error: "Слишком много попыток. Попробуйте позже." },
});
export const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // 20 payment-init calls per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skip: rateLimitDisabled,
  message: { error: "Слишком много запросов. Попробуйте позже." },
});

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

// --- Pagination ------------------------------------------------------------
// Parse optional limit/offset query params for admin list endpoints (audit M5).
// When `limit` is absent the caller wants the full list (client-side search /
// CSV export rely on this), so we return offset only and the storage layer skips
// LIMIT. When present, `limit` is clamped to [1, MAX_PAGE_LIMIT] so a client can
// never ask for an unbounded page, and `offset` is floored at 0. The default
// page size (50) is a client concern; the server only enforces the ceiling.
export const MAX_PAGE_LIMIT = 200;
export function parsePageParams(req: Request): { limit?: number; offset: number } {
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
  if (req.query.limit === undefined) return { offset };
  const limit = Math.min(Math.max(1, Math.floor(Number(req.query.limit) || 0)), MAX_PAGE_LIMIT);
  return { limit, offset };
}

// --- Rate limiters ---------------------------------------------------------
// We sit behind nginx with `trust proxy` set, so the limiter keys on the real
// client IP (first X-Forwarded-For hop). Standard headers on, legacy off.
//
// OTP start dispatches a REAL SMS (direct cost) and OTP verify is a code
// guess — both are prime abuse targets, so they get a tight limit. Payment
// init endpoints redirect to the acquirer; abuse there spams order creation,
// so they get a looser limit. The T-Bank notification webhook stays
// deliberately generous (audit MEDIUM #2): it is server-to-server from the
// bank and a real notification burst must never be dropped, but an
// unauthenticated public POST endpoint that does HMAC verification and JSON
// parsing before any auth check is still a volumetric-DoS target, so it gets
// a ceiling far above anything real payment traffic could ever produce.
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

// Audit MEDIUM #3: otpLimiter above keys purely on source IP. The DB-level
// defenses (60s resend lock + 5-attempts-per-code lockout in
// server/storage/otp.ts, both keyed on the phone number itself) already stop
// a distributed attacker from actually guessing a code or spamming SMS to one
// target number regardless of how many IPs they rotate through — but every
// one of those rejected requests still pays for a DB transaction with a row
// lock before being turned down. This second limiter keys on the *phone
// number in the request body* so a many-IP flood aimed at one number gets
// turned away at the edge, before it ever reaches the DB. Deliberately
// looser than the per-phone DB locks (which are the real security boundary)
// so it only kicks in on genuine abuse, not normal retry UX.
function otpPhoneKey(req: Request): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.phone;
  const digits = typeof raw === "string" ? raw.replace(/\D/g, "") : "";
  if (digits.length >= 10) return `phone:${digits}`;
  // /api/users/me/phone/verify only carries { code } — the target phone is
  // whatever change request is pending for the session, not in the body —
  // so key on the authenticated rider instead, which is just as precise.
  const userId = req.session?.userId;
  if (userId) return `user:${userId}`;
  // No parseable phone and no session: fall back to IP so malformed requests
  // don't all pile into one shared "unknown" bucket (which itself would
  // become a denial-of-service lever against everyone hitting it at once).
  return `ip:${req.ip}`;
}
export const otpPhoneLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 8, // 8 start+verify calls per phone number per window, across all IPs
  standardHeaders: true,
  legacyHeaders: false,
  skip: rateLimitDisabled,
  keyGenerator: otpPhoneKey,
  message: { error: "Слишком много попыток для этого номера. Попробуйте позже." },
});
export const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // 20 payment-init calls per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skip: rateLimitDisabled,
  message: { error: "Слишком много запросов. Попробуйте позже." },
});
// A reservation holds ONE bike unavailable to everyone else for up to 10
// minutes — cheap for the caller but a real griefing vector (repeatedly
// book-then-let-expire to keep a bike perpetually out of the pool). Tighter
// than paymentLimiter, looser than otpLimiter.
export const reservationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 create/cancel calls per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skip: rateLimitDisabled,
  message: { error: "Слишком много запросов. Попробуйте позже." },
});
// One legitimate submission per ride, but the dialog resubmits on edit — this
// only needs to stop scripted spam, not throttle real usage.
export const feedbackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: rateLimitDisabled,
  message: { error: "Слишком много запросов. Попробуйте позже." },
});
// At 300 bikes, a single order produces at most a handful of notifications
// (AUTHORIZED/CONFIRMED, and REJECTED on failure); even a large fleet running
// hot would stay two to three orders of magnitude below this ceiling. This
// exists purely to cap the cost of unauthenticated HMAC+JSON parsing during a
// volumetric flood, not to throttle T-Bank itself — T-Bank's own notification
// IP range is fixed and small, so tripping this in production would mean
// something is already very wrong upstream, not normal traffic.
export const tbankWebhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 600, // 10 req/s sustained per source IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: rateLimitDisabled,
  message: { error: "Too many requests" },
});

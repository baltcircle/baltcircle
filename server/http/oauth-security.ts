import type { Express } from "express";
import rateLimit from "express-rate-limit";

export const OAUTH_REQUESTS_PER_MINUTE = 60;

// Keep OAuth separate from OTP/SMS and from the identity-management budget.
// Trust proxy is configured centrally; never key on an unverified header here.
const skipOutsideProduction = () =>
  process.env.NODE_ENV !== "production" && process.env.DISABLE_RATE_LIMIT === "1";

export function registerOAuthProtection(app: Express): void {
  const flowLimiter = rateLimit({
    windowMs: 60_000,
    max: OAUTH_REQUESTS_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipOutsideProduction,
    message: { error: "Слишком много попыток входа. Попробуйте позже." },
  });
  const identityLimiter = rateLimit({
    windowMs: 60_000,
    max: OAUTH_REQUESTS_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipOutsideProduction,
    message: { error: "Слишком много запросов. Попробуйте позже." },
  });

  // Registered before auth routes, including provider starts and callbacks.
  app.use("/api/auth/yandex", flowLimiter);
  app.use("/api/auth/vk", flowLimiter);
  app.use("/api/users/me/oauth", identityLimiter);
}

import type { Request, RequestHandler } from "express";
import { csrfSync } from "csrf-sync";

// Only independently authenticated service endpoints are exempt. No prefix match.
const CSRF_EXEMPT_PATHS = new Set<string>([
  "/api/payments/tbank/notification",
  "/api/telemetry/bike",
]);
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
const safeMethods = new Set<string>(SAFE_METHODS);

const csrf = csrfSync({
  ignoredMethods: [...SAFE_METHODS],
  getTokenFromRequest: (req) => {
    const token = req.headers["x-csrf-token"];
    return typeof token === "string" ? token : undefined;
  },
  skipCsrfProtection: (req) => CSRF_EXEMPT_PATHS.has(req.path),
});

export const generateToken = csrf.generateToken;

// Keep validation in csrf-sync, but make the session-token dependency explicit
// at the registered middleware boundary for review, tests and static analysis.
function validateSessionCsrfToken(token: unknown, req: Request): boolean {
  return typeof token === "string" && csrf.isRequestValid(req);
}

export const csrfSynchronisedProtection: RequestHandler = (req, res, next) => {
  if (
    !safeMethods.has(req.method) &&
    !CSRF_EXEMPT_PATHS.has(req.path) &&
    !validateSessionCsrfToken(req.session?.csrfToken, req)
  ) {
    return next(csrf.invalidCsrfTokenError);
  }
  // Preserve csrf-sync's request helper, error object and actual enforcement.
  return csrf.csrfSynchronisedProtection(req, res, next);
};

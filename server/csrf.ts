import { csrfSync } from "csrf-sync";

// Synchronizer Token Pattern (session-backed) — chosen over the double-submit
// cookie pattern because the app already runs `express-session` with a
// server-side store, so the token can live in `req.session` and never touch
// the client except as an explicit header value.
//
// Endpoints below are POST but are never called with a browser session
// cookie, so a synchronizer token can never be attached to them — CSRF does
// not apply:
//  - /api/payments/tbank/notification — T-Bank's server-to-server webhook,
//    authenticated by a shared secret token verified in the request body
//    (see verifyNotificationToken in server/http/payments.ts).
//  - /api/telemetry/bike — HTTP fallback ingest for trackers that can't speak
//    the OMNI TCP protocol, authenticated by a bearer device token
//    (TELEMETRY_INGEST_TOKEN), not a rider session.
const CSRF_EXEMPT_PATHS = new Set<string>([
  "/api/payments/tbank/notification",
  "/api/telemetry/bike",
]);

export const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.headers["x-csrf-token"] as string | undefined,
  skipCsrfProtection: (req) => CSRF_EXEMPT_PATHS.has(req.path),
});

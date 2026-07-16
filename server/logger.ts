import pino from "pino";

// Structured application logger (audit L6 — replaces ad-hoc console.*/self-made
// log() without levels or structure). Emits JSON with levels; the level is
// configurable via LOG_LEVEL and defaults to `info` in production, `debug`
// elsewhere. Sensitive fields are redacted centrally so a stray structured log
// never leaks PII (phone/email), auth secrets (OTP/tokens/passwords) or payment
// data — mirroring the response-body redaction in server/index.ts (audit H1).
const level =
  process.env.LOG_LEVEL ??
  (process.env.NODE_ENV === "production" ? "info" : "debug");

export const logger = pino({
  level,
  redact: {
    paths: [
      "phone", "email", "otp", "code", "password", "token", "secret",
      "card", "pan", "cvv", "cvc", "rebill", "auth",
      "*.phone", "*.email", "*.otp", "*.code", "*.password", "*.token",
      "*.secret", "*.card", "*.pan", "*.cvv", "*.cvc", "*.rebill", "*.auth",
    ],
    censor: "[REDACTED]",
  },
});

// Backward-compatible helper kept for existing `import { log } from "../index"`
// call sites. Routes a plain message through pino at info level, tagged with the
// calling subsystem (`source`) so log output stays greppable per module.
export function log(message: string, source = "express") {
  logger.info({ source }, message);
}

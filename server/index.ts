import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool, bootstrapReady } from "./storage";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { logger, log } from "./logger";

// Re-exported so existing `import { log } from "../index"` call sites keep
// working now that the implementation lives in server/logger.ts (audit L6).
export { log };

const app = express();
const httpServer = createServer(app);

// Session-based rider identity. The session id lives in an httpOnly cookie that
// survives refresh on the same device, so a registered rider stays recognized
// without any SMS/auth provider. Sessions are persisted in a `session` table in
// the managed Postgres database, reusing the shared pg connection pool. Because
// the database is external and durable, sessions survive Node/Docker restarts
// and redeploys — a registered rider stays logged in across deploys without
// re-registering.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const PgStore = connectPgSimple(session);

// Session signing secret. The dev default is a public string and must NEVER be
// used in production — signing sessions with a known secret lets anyone forge a
// session cookie. Fail fast at startup rather than silently running insecure.
const DEV_SESSION_SECRET = "baltcircle-dev-session-secret";
const sessionSecret = process.env.SESSION_SECRET || DEV_SESSION_SECRET;
if (process.env.NODE_ENV === "production" && sessionSecret === DEV_SESSION_SECRET) {
  logger.fatal(
    "SESSION_SECRET is not set (or equals the public dev default) in production. " +
      "Set a strong, secret SESSION_SECRET and restart. Refusing to start.",
  );
  process.exit(1);
}

app.set("trust proxy", 1);
app.use(
  session({
    name: "bc.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: new PgStore({
      pool,
      // connect-pg-simple creates the `session` table on first use if missing.
      createTableIfMissing: true,
      // Sweep expired rows hourly; expiry itself is enforced per-row via the
      // `expire` column written from the cookie maxAge below.
      pruneSessionInterval: 60 * 60,
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS,
    },
  }),
);

declare module "express-session" {
  interface SessionData {
    userId?: string;
    // OAuth CSRF state — per provider we remember the `state` value we sent to
    // the authorize endpoint, verified in the callback before exchanging code.
    oauthState?: { yandex?: string; vk?: string; vkCodeVerifier?: string };
  }
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: "12mb", // вложения в support-чат шлются base64 в body (лимит файла ~8 МБ + overhead)
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Keys whose values must never reach the logs — PII (phone/email), auth secrets
// (OTP/codes/tokens/passwords) and payment data (PANs). Matched case-insensitively
// as a substring so `phoneNumber`, `cardNumber`, `accessToken` etc. are all caught.
const SENSITIVE_KEY_PATTERNS = [
  "phone", "email", "otp", "code", "password", "pass", "token",
  "secret", "card", "pan", "cvv", "cvc", "rebill", "auth", "session",
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

// Recursively redact sensitive fields so a debug body dump never leaks PII or
// secrets. Depth-limited to avoid pathological/cyclic payloads.
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Log response bodies only when explicitly opted in via LOG_RESPONSE_BODY=1, and
// even then with sensitive fields redacted and the payload length-capped. By
// default we log only method/path/status/latency (audit H1 — the old logger
// dumped full JSON bodies, leaking phones, emails, dev OTP codes and payment
// statuses into the logs).
const LOG_RESPONSE_BODY = process.env.LOG_RESPONSE_BODY === "1";

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  // Correlation id per request: honour an inbound X-Request-Id (e.g. from nginx)
  // or mint one, echo it back, and tag every log line for this request so a
  // request can be traced end-to-end across log lines (audit L6).
  const reqId = (req.headers["x-request-id"] as string) || randomUUID();
  res.setHeader("x-request-id", reqId);
  let capturedJsonResponse: unknown = undefined;

  if (LOG_RESPONSE_BODY) {
    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
  }

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const fields: Record<string, unknown> = {
        reqId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: duration,
      };
      if (LOG_RESPONSE_BODY && capturedJsonResponse !== undefined) {
        let dump = JSON.stringify(redact(capturedJsonResponse));
        if (dump.length > 500) dump = dump.slice(0, 500) + "…";
        fields.body = dump;
      }
      logger.info(fields, `${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

(async () => {
  // Postgres pool + schema/migrations/seed must be ready before we serve any
  // request (routes touch storage on the first hit). bootstrapReady resolves
  // once the async bootstrap in server/db/bootstrap.ts has completed.
  await bootstrapReady;

  // Статика вложений чата поддержки. Локальный диск MVP; при переезде на
  // Yandex Object Storage — URL-ы абсолютные, блок можно будет убрать.
  const uploadsDir = process.env.UPLOADS_DIR ?? path.resolve(process.cwd(), "uploads");
  try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch { /* ignore */ }
  app.use("/uploads", express.static(uploadsDir, {
    maxAge: "7d",
    fallthrough: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "private, max-age=604800, immutable");
    },
  }));

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    logger.error({ err, status }, "Internal Server Error");

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes.
  // API_ONLY skips the client layer entirely (no vite, no static) — used by the
  // API smoke tests, which only exercise JSON endpoints.
  if (process.env.API_ONLY === "1") {
    // no client middleware
  } else if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();

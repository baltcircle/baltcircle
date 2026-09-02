import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool, bootstrapReady, storage } from "./storage";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { logger, log } from "./logger";
import { OmniTcpServer } from "./omni/server";
import { PgOmniStore } from "./omni/store";
import { setLockGateway } from "./omni/gateway";

// Re-exported so existing `import { log } from "../index"` call sites keep
// working now that the implementation lives in server/logger.ts (audit L6).
export { log };

const app = express();
const httpServer = createServer(app);

// audit HIGH #10: graceful shutdown. Before this, SIGTERM only cleared a few
// in-process timers and stopped the OMNI TCP gateway — the HTTP server kept
// accepting/serving requests and the Postgres pool was never closed, so every
// deploy (a SIGTERM on each push to main) either hard-dropped in-flight
// requests/SSE streams once the orchestrator gave up and SIGKILLed the
// process, or left keep-alive connections/pool clients open with no defined
// endpoint at all. Callers below register cleanup work here instead of their
// own scattered process.once("SIGTERM"/"SIGINT") pairs; shutdown() below runs
// them all, then drains the HTTP server and the DB pool before exiting.
const shutdownTasks: Array<() => void | Promise<void>> = [];
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // second SIGTERM/SIGINT while draining — ignore, let the first run finish
  shuttingDown = true;
  logger.info({ signal }, "shutdown: received signal, draining gracefully");

  // If graceful drain hangs (stuck query, slow client, buggy cleanup), force
  // exit rather than rely on the orchestrator's SIGKILL, which forcibly cuts
  // the DB connection mid-transaction instead of letting the pool close it.
  const FORCE_EXIT_MS = 10_000;
  const forceExitTimer = setTimeout(() => {
    logger.error({ signal }, "shutdown: graceful drain timed out, forcing exit");
    process.exit(1);
  }, FORCE_EXIT_MS);

  try {
    // Stop accepting new connections; node keeps serving already-open
    // keep-alive/SSE connections until they finish or the client disconnects.
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    const results = await Promise.allSettled(shutdownTasks.map((task) => Promise.resolve().then(task)));
    for (const result of results) {
      if (result.status === "rejected") {
        logger.error({ err: result.reason }, "shutdown: a cleanup task failed");
      }
    }

    await pool.end();
    logger.info({ signal }, "shutdown: complete");
    process.exitCode = 0;
  } catch (err) {
    logger.error({ err, signal }, "shutdown: error during graceful drain");
    process.exitCode = 1;
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(process.exitCode ?? 0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

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

  // Audit MEDIUM (Платежи track): otp_requests/phone_change_requests/
  // email_change_requests had no periodic cleanup and could retain PII
  // (name, target phone/email, SMS/email provider diagnostics) forever.
  // This process runs 24/7 in production, so an in-process sweep needs no
  // extra infra/cost — same pattern already used for the session store
  // (connect-pg-simple's pruneSessionInterval above) and the OMNI lock
  // gateway's offline-lock sweep (server/omni/server.ts). Runs once shortly
  // after boot, then hourly.
  const runContactRequestPurge = () => {
    void storage.purgeExpiredContactRequests()
      .then(({ otp, phoneChange, emailChange }) => {
        if (otp || phoneChange || emailChange) {
          logger.info({ otp, phoneChange, emailChange }, "purged expired otp/contact-change requests");
        }
      })
      .catch((err) => logger.error({ err }, "contact-request purge failed"));
  };
  const CONTACT_REQUEST_PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly, matches session-store sweep
  const initialPurgeTimer = setTimeout(runContactRequestPurge, 30_000);
  const contactRequestPurgeTimer = setInterval(runContactRequestPurge, CONTACT_REQUEST_PURGE_INTERVAL_MS);
  shutdownTasks.push(() => { clearTimeout(initialPurgeTimer); clearInterval(contactRequestPurgeTimer); });

  // Reservations ("бронь") hold a bike out of the rentable pool for up to
  // RESERVATION_TTL_MS (10 min, shared/geo.ts) — a much shorter fuse than the
  // hourly contact-request purge above, so this sweep runs every 60 seconds
  // instead. storage.expireOverdueReservations() does the actual flip
  // (reservation -> "expired", bike -> "available") atomically in one
  // transaction; this timer is just the scheduler.
  const runReservationSweep = () => {
    void storage.expireOverdueReservations()
      .then((count) => {
        if (count > 0) logger.info({ count }, "expired overdue reservations");
      })
      .catch((err) => logger.error({ err }, "reservation sweep failed"));
  };
  const RESERVATION_SWEEP_INTERVAL_MS = 60 * 1000;
  const initialReservationSweepTimer = setTimeout(runReservationSweep, 10_000);
  const reservationSweepTimer = setInterval(runReservationSweep, RESERVATION_SWEEP_INTERVAL_MS);
  shutdownTasks.push(() => { clearTimeout(initialReservationSweepTimer); clearInterval(reservationSweepTimer); });

  // Audit (scalability): bike_telemetry (lock heartbeat/GPS check-ins) had no
  // retention policy and grows without bound as the fleet and ping rate grow
  // — unlike ride_points (permanent per-ride track), it's disposable noise
  // past TELEMETRY_RETENTION_MS (30 days, server/storage/bike.ts). Same
  // in-process-timer pattern as the sweeps above; batched internally so a
  // large backlog can't hold a long-running delete against a hot table.
  const runTelemetryPurge = () => {
    void storage.purgeOldTelemetry()
      .then((count) => {
        if (count > 0) logger.info({ count }, "purged old bike telemetry");
      })
      .catch((err) => logger.error({ err }, "telemetry purge failed"));
  };
  const TELEMETRY_PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly, matches contact-request purge
  const initialTelemetryPurgeTimer = setTimeout(runTelemetryPurge, 45_000);
  const telemetryPurgeTimer = setInterval(runTelemetryPurge, TELEMETRY_PURGE_INTERVAL_MS);
  shutdownTasks.push(() => { clearTimeout(initialTelemetryPurgeTimer); clearInterval(telemetryPurgeTimer); });

  // The gateway is a standalone TCP listener (not an HTTP route), but it shares
  // this process so the authenticated pilot-control endpoint can address its
  // in-memory socket registry without a second control plane.
  const configuredGatewayPort = Number(process.env.LOCK_GATEWAY_PORT || "5100");
  const gatewayInt = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  };
  const lockGateway = new OmniTcpServer({
    store: new PgOmniStore(),
    logger,
    port: Number.isInteger(configuredGatewayPort) && configuredGatewayPort > 0 ? configuredGatewayPort : 5100,
    host: process.env.LOCK_GATEWAY_HOST || "0.0.0.0",
    maxConnections: gatewayInt("OMNI_MAX_CONNECTIONS", 500),
    idleTimeoutMs: gatewayInt("OMNI_IDLE_TIMEOUT_MS", 15 * 60_000),
    statusMinIntervalMs: gatewayInt("OMNI_STATUS_MIN_INTERVAL_MS", 60_000),
    writer: {
      flushIntervalMs: gatewayInt("OMNI_FLUSH_INTERVAL_MS", 2_000),
      maxBatchRows: gatewayInt("OMNI_MAX_BATCH_ROWS", 500),
    },
    // bike-status lifecycle spec, 2026-09: second, accurate parkingId pass
    // once the fix armParkingRecalc() is waiting for actually lands. Runs
    // outside any request/response cycle, so failures are logged and
    // swallowed rather than surfaced to a caller that no longer exists.
    onParkingRecalcFix: (bikeId, lat, lng) => {
      storage.recalculateBikeParking({ id: bikeId, lat, lng }).catch((err) => {
        logger.error({ err, bikeId }, "post-status-change parking recalc failed");
      });
    },
  });
  await lockGateway.listen();
  setLockGateway(lockGateway);
  shutdownTasks.push(async () => {
    setLockGateway(null);
    await lockGateway.close();
  });

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

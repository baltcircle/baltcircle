import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool, bootstrapReady } from "./storage";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs";

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
  console.error(
    "FATAL: SESSION_SECRET is not set (or equals the public dev default) in production. " +
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

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
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

    console.error("Internal Server Error:", err);

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

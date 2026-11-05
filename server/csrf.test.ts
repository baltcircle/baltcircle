import { describe, expect, it } from "vitest";
import express from "express";
import type { ErrorRequestHandler } from "express";
import session from "express-session";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { csrfSynchronisedProtection, generateToken } from "./csrf";

async function withHttp(run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use(session({
    name: "bc.sid",
    secret: "csrf-test",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: false },
  }));
  app.get("/api/csrf-token", (req, res) => { res.json({ csrfToken: generateToken(req) }); });
  app.use(csrfSynchronisedProtection);
  app.post("/api/test-regenerate", (req, res, next) => {
    req.session.regenerate((err) => {
      if (err) return next(err);
      res.json({ csrfToken: generateToken(req) });
    });
  });
  // This fixture only tests CSRF exemptions; service authentication is unchanged.
  app.use((_req, res) => { res.status(204).end(); });
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    const error = err as { status?: number; code?: string };
    res.status(error.status ?? 500).json({ code: error.code });
  };
  app.use(errors);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
}

async function issue(base: string) {
  const response = await fetch(base + "/api/csrf-token");
  expect(response.status).toBe(200);
  const body = await response.json() as { csrfToken: string };
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  expect(body.csrfToken.length).toBeGreaterThan(0);
  return { cookie, token: body.csrfToken };
}

async function status(base: string, method: string, headers: Record<string, string> = {}, path = "/api/protected", body?: string) {
  const response = await fetch(base + path, { method, headers, body });
  const code = response.status;
  if (code === 403) expect(await response.json()).toMatchObject({ code: "EBADCSRFTOKEN" });
  else await response.text();
  return code;
}

describe("session-backed CSRF boundary", () => {
  it("keeps the production session/token/protection/routes order", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const sessionAt = source.indexOf("session({");
    const tokenAt = source.indexOf('app.get("/api/csrf-token"');
    const protectionAt = source.indexOf("app.use(csrfSynchronisedProtection)");
    const routesAt = source.indexOf("await registerRoutes(httpServer, app)");
    expect(sessionAt).toBeGreaterThan(-1);
    expect(tokenAt).toBeGreaterThan(sessionAt);
    expect(protectionAt).toBeGreaterThan(tokenAt);
    expect(routesAt).toBeGreaterThan(protectionAt);
  });

  it("allows safe methods without creating a token requirement", async () => {
    await withHttp(async (base) => {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect(await status(base, method)).toBe(204);
      }
    });
  });

  it("rejects missing, incorrect and cookie-less tokens for every mutating method", async () => {
    await withHttp(async (base) => {
      const identity = await issue(base);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(await status(base, method, { cookie: identity.cookie })).toBe(403);
        expect(await status(base, method, { cookie: identity.cookie, "x-csrf-token": "incorrect" })).toBe(403);
        expect(await status(base, method, { "x-csrf-token": identity.token })).toBe(403);
        expect(await status(base, method, { cookie: identity.cookie, "x-csrf-token": identity.token })).toBe(204);
      }
    });
  });

  it("rejects another session's token and tokens supplied only in body/query", async () => {
    await withHttp(async (base) => {
      const first = await issue(base);
      const second = await issue(base);
      expect(first.token).not.toBe(second.token);
      expect(await status(base, "POST", { cookie: second.cookie, "x-csrf-token": first.token })).toBe(403);
      expect(await status(base, "POST", { cookie: first.cookie, "content-type": "application/json" }, "/api/protected", JSON.stringify({ csrfToken: first.token }))).toBe(403);
      expect(await status(base, "POST", { cookie: first.cookie }, `/api/protected?csrfToken=${first.token}`)).toBe(403);
    });
  });

  it("preserves only the two exact service exemptions", async () => {
    await withHttp(async (base) => {
      for (const path of ["/api/payments/tbank/notification", "/api/telemetry/bike"]) {
        expect(await status(base, "POST", {}, path)).toBe(204);
        expect(await status(base, "POST", {}, path + "/extra")).toBe(403);
      }
      expect(await status(base, "POST", {}, "/api/users/me/oauth/vk/unlink")).toBe(403);
    });
  });

  it("rejects the old token after session regeneration and accepts the new one", async () => {
    await withHttp(async (base) => {
      const before = await issue(base);
      const response = await fetch(base + "/api/test-regenerate", {
        method: "POST", headers: { cookie: before.cookie, "x-csrf-token": before.token },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { csrfToken: string };
      const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(cookie).not.toBe("");
      expect(cookie).not.toBe(before.cookie);
      expect(body.csrfToken).not.toBe(before.token);
      expect(await status(base, "POST", { cookie, "x-csrf-token": before.token })).toBe(403);
      expect(await status(base, "POST", { cookie, "x-csrf-token": body.csrfToken })).toBe(204);
    });
  });
});

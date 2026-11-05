import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { OAUTH_REQUESTS_PER_MINUTE, registerOAuthProtection } from "./oauth-security";

afterEach(() => { vi.unstubAllEnvs(); });

async function withHttp(run: (base: string) => Promise<void>) {
  const app = express();
  registerOAuthProtection(app);
  // Fixture handlers verify rejection before downstream work, not provider APIs.
  app.use((_req, res) => { res.status(204).end(); });
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

async function request(base: string, path: string, method = "GET") {
  const response = await fetch(base + path, { method });
  const result = { status: response.status, retryAfter: response.headers.get("retry-after") };
  await response.text();
  return result;
}

describe("OAuth rate-limit boundaries", () => {
  it("registers protection before the real auth routes", () => {
    const source = readFileSync(new URL("../routes.ts", import.meta.url), "utf8");
    const protection = source.indexOf("registerOAuthProtection(app);");
    const auth = source.indexOf("registerAuthRoutes(app);");
    expect(protection).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(protection);
    expect(OAUTH_REQUESTS_PER_MINUTE).toBe(60);
  });

  it("shares the Yandex/VK flow budget and enforces it in production despite the bypass flag", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DISABLE_RATE_LIMIT", "1");
    const paths = ["/api/auth/yandex/start", "/api/auth/yandex/callback", "/api/auth/vk/start", "/api/auth/vk/callback"];
    await withHttp(async (base) => {
      for (let i = 0; i < OAUTH_REQUESTS_PER_MINUTE; i++) {
        expect((await request(base, paths[i % paths.length])).status).toBe(204);
      }
      for (const path of paths) {
        const blocked = await request(base, path);
        expect(blocked.status).toBe(429);
        expect(blocked.retryAfter).not.toBeNull();
      }
      expect((await request(base, "/api/users/me/oauth")).status).toBe(204);
      expect((await request(base, "/api/auth/otp/start", "POST")).status).toBe(204);
    });
  }, 15_000);

  it("shares identity read/unlink limits without consuming the provider-flow or OTP budgets", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DISABLE_RATE_LIMIT", "1");
    await withHttp(async (base) => {
      for (let i = 0; i < OAUTH_REQUESTS_PER_MINUTE; i++) {
        const unlink = i % 2 === 1;
        expect((await request(base, unlink ? "/api/users/me/oauth/vk/unlink" : "/api/users/me/oauth", unlink ? "POST" : "GET")).status).toBe(204);
      }
      expect((await request(base, "/api/users/me/oauth")).status).toBe(429);
      expect((await request(base, "/api/users/me/oauth/yandex/unlink", "POST")).status).toBe(429);
      expect((await request(base, "/api/auth/yandex/callback")).status).toBe(204);
      expect((await request(base, "/api/auth/otp/verify", "POST")).status).toBe(204);
    });
  }, 15_000);

  it("preserves the explicit non-production bypass", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DISABLE_RATE_LIMIT", "1");
    await withHttp(async (base) => {
      for (let i = 0; i <= OAUTH_REQUESTS_PER_MINUTE; i++) {
        expect((await request(base, "/api/auth/yandex/start")).status).toBe(204);
      }
    });
  }, 15_000);

  it("enforces limits outside production when bypass is not requested", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DISABLE_RATE_LIMIT", "0");
    await withHttp(async (base) => {
      for (let i = 0; i < OAUTH_REQUESTS_PER_MINUTE; i++) {
        expect((await request(base, "/api/users/me/oauth")).status).toBe(204);
      }
      expect((await request(base, "/api/users/me/oauth")).status).toBe(429);
    });
  }, 15_000);
});

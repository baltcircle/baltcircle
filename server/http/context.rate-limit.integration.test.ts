import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../storage", () => ({ storage: {} }));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("OTP rate-limit production bypass regression", () => {
  it.each([
    { env: "production", expected: 429 },
    { env: "development", expected: 200 },
    { env: "test", expected: 200 },
  ])("sixth request in $env returns $expected even with bypass flag", async ({ env, expected }) => {
    vi.stubEnv("NODE_ENV", env);
    vi.stubEnv("DISABLE_RATE_LIMIT", "1");
    const { otpLimiter } = await import("./context");
    const app = express();
    app.get("/probe", otpLimiter, (_req, res) => res.json({ ok: true }));
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const { port } = server.address() as AddressInfo;
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const response = await fetch(`http://127.0.0.1:${port}/probe`);
        statuses.push(response.status);
        await response.text();
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, expected]);
    } finally {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
    }
  });
});

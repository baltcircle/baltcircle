// Smoke test for the T-Bank payment routes when acquiring is NOT configured.
//
// Boots the real Express server against a throwaway SQLite DB with NO T-Bank
// credentials and asserts the app degrades gracefully:
//   1. GET /api/payments/tbank/config -> { configured: false }
//   2. POST add-card (registered rider) -> 503 "Платежи настраиваются"
//   3. POST notification -> 503 (no config) / never crashes the server
// The server must stay up and keep serving /api/bikes throughout.
//
// Run with:  npx tsx script/smoke-tbank-routes.ts

import { rmSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

const PORT = 5607;
const DB_PATH = "/tmp/bc-smoke-tbank.db";
const BASE = `http://127.0.0.1:${PORT}`;

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (existsSync(f)) rmSync(f);
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

function startServer(): ChildProcess {
  return spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
    {
      // Deliberately NO TBANK_TERMINAL_KEY / TBANK_PASSWORD.
      env: {
        ...process.env,
        NODE_ENV: "development",
        API_ONLY: "1",
        PORT: String(PORT),
        DATABASE_PATH: DB_PATH,
        SMS_PROVIDER: "",
        TBANK_TERMINAL_KEY: "",
        TBANK_PASSWORD: "",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/bikes`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Server did not start in time");
}

function cookieFromSetCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

async function stop(proc: ChildProcess) {
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
}

const server = startServer();

async function main() {
  await waitForServer();

  // Config probe reports unconfigured.
  let res = await fetch(`${BASE}/api/payments/tbank/config`);
  assert(res.status === 200, "config probe returns 200");
  const cfg = await res.json();
  assert(cfg.configured === false, "config probe reports configured=false");

  // Register a rider via the OTP dev fallback to get a session cookie.
  res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иван Тестов", phone: "8 (900) 111-22-33", consent: true }),
  });
  assert(res.status === 200, "otp start returns 200");
  const startBody = await res.json();
  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: startBody.phone, code: startBody.devCode }),
  });
  assert(res.status === 201, "otp verify returns 201");
  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"));
  assert(!!cookie, "verify sets a session cookie");

  // add-card -> 503 when unconfigured.
  res = await fetch(`${BASE}/api/payments/tbank/add-card`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookie! },
  });
  assert(res.status === 503, "add-card returns 503 when T-Bank not configured");

  // add-card without a session -> 401 (registered-only).
  res = await fetch(`${BASE}/api/payments/tbank/add-card`, { method: "POST" });
  assert(res.status === 401, "add-card requires a session (401 unregistered)");

  // bind-card-payment (the primary path) -> 503 when unconfigured.
  res = await fetch(`${BASE}/api/payments/tbank/bind-card-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookie! },
  });
  assert(res.status === 503, "bind-card-payment returns 503 when T-Bank not configured");

  // bind-card-payment without a session -> 401 (registered-only).
  res = await fetch(`${BASE}/api/payments/tbank/bind-card-payment`, { method: "POST" });
  assert(res.status === 401, "bind-card-payment requires a session (401 unregistered)");

  // notification -> 503 (no config) and the server stays alive.
  res = await fetch(`${BASE}/api/payments/tbank/notification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ OrderId: "x", Token: "y" }),
  });
  assert(res.status === 503, "notification returns 503 when T-Bank not configured");

  // Server still healthy.
  res = await fetch(`${BASE}/api/bikes`);
  assert(res.ok, "server still serves /api/bikes after the payment calls");

  if (!process.exitCode) console.log("\nAll T-Bank route (unconfigured) smoke checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stop(server);
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });

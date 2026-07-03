// Smoke test for the ordinary T-Bank ride-payment path (pay-then-start).
//
// Two parts:
//   1. Pure checks (no server): generateRideOrderId() always yields a 1..50-char
//      ASCII order id (T-Bank Init rejects longer with code 212), and
//      classifyRidePayment() maps statuses to paid/failed/pending correctly.
//   2. Server checks against a throwaway DB with NO T-Bank credentials: the
//      ride/init route degrades to 503 (configured) / 401 (no session), the
//      status route is session-gated, and the notification webhook never crashes
//      the server (idempotent + 503 when unconfigured).
//
// Run with:  npx tsx script/smoke-tbank-ride-payment.ts

import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown } from "./smoke-pg";
import { generateRideOrderId, classifyRidePayment } from "../server/tbank";

const PORT = 5613;
const NAME = "tbank-ride-payment";
let DB_URL = "";
let server: ChildProcess;
const BASE = `http://127.0.0.1:${PORT}`;


function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

// ---- Part 1: pure checks (no server needed) ----
for (let i = 0; i < 5000; i++) {
  const id = generateRideOrderId();
  if (id.length < 1 || id.length > 50 || !/^[A-Za-z0-9-]+$/.test(id)) {
    assert(false, `generateRideOrderId produced an invalid id: "${id}" (len ${id.length})`);
  }
}
assert(true, "generateRideOrderId always yields a 1..50-char ASCII id (5000 samples)");

assert(classifyRidePayment({ status: "CONFIRMED" }) === "paid", "CONFIRMED -> paid");
assert(classifyRidePayment({ status: "AUTHORIZED" }) === "paid", "AUTHORIZED -> paid");
assert(classifyRidePayment({ status: "REJECTED" }) === "failed", "REJECTED -> failed");
assert(classifyRidePayment({ status: "NEW", success: false }) === "failed", "Success=false -> failed");
assert(classifyRidePayment({ status: "FORM_SHOWED" }) === "pending", "FORM_SHOWED -> pending");
assert(classifyRidePayment({}) === "pending", "empty -> pending");

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
        DATABASE_URL: DB_URL,
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


async function main() {
  DB_URL = (await createTestDb(NAME)).url;
  server = startServer();
  await waitForServer();

  // ride/init without a session -> 401 (registered-only).
  let res = await fetch(`${BASE}/api/payments/tbank/ride/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bikeId: "BC-001", tariffId: "h1" }),
  });
  assert(res.status === 401, "ride/init requires a session (401 unregistered)");

  // Register a rider via the OTP dev fallback to get a session cookie.
  res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иван Тестов", phone: "8 (900) 222-33-44", consent: true }),
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

  // Discover an available demo bike to exercise the validation path.
  const bikes = await (await fetch(`${BASE}/api/bikes`)).json();
  const available = (bikes as { id: string; status: string }[]).find((b) => b.status === "available");
  assert(!!available, "there is at least one available demo bike");

  // ride/init for an available bike, valid tariff -> 503 when unconfigured
  // (validation passes; only the missing acquirer config blocks it).
  res = await fetch(`${BASE}/api/payments/tbank/ride/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookie! },
    body: JSON.stringify({ bikeId: available!.id, tariffId: "h1" }),
  });
  assert(res.status === 503, "ride/init returns 503 when T-Bank not configured");

  // ride/init with an unknown bike -> 404 (validation runs before the config check).
  res = await fetch(`${BASE}/api/payments/tbank/ride/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookie! },
    body: JSON.stringify({ bikeId: "NO-SUCH-BIKE", tariffId: "h1" }),
  });
  assert(res.status === 404, "ride/init returns 404 for an unknown bike");

  // ride/init with a bad tariff -> 400.
  res = await fetch(`${BASE}/api/payments/tbank/ride/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookie! },
    body: JSON.stringify({ bikeId: available!.id, tariffId: "nope" }),
  });
  assert(res.status === 400, "ride/init returns 400 for an unknown tariff");

  // status route without a session -> 401.
  res = await fetch(`${BASE}/api/payments/tbank/ride/whatever`);
  assert(res.status === 401, "ride status route requires a session (401 unregistered)");

  // status route for an unknown order (with session) -> 404.
  res = await fetch(`${BASE}/api/payments/tbank/ride/whatever`, { headers: { cookie: cookie! } });
  assert(res.status === 404, "ride status route returns 404 for an unknown order");

  // notification with a ride-style OrderId -> 503 (no config) and server survives.
  res = await fetch(`${BASE}/api/payments/tbank/notification`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ OrderId: generateRideOrderId(), Status: "CONFIRMED", Token: "x" }),
  });
  assert(res.status === 503, "notification returns 503 when T-Bank not configured");

  // Server still healthy.
  res = await fetch(`${BASE}/api/bikes`);
  assert(res.ok, "server still serves /api/bikes after the ride-payment calls");

  if (!process.exitCode) console.log("\nAll T-Bank ride-payment smoke checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown(NAME, server);
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });

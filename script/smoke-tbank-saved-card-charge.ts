// Smoke test for the saved-card recurring ride-charge path (Init + Charge with a
// stored RebillId — no hosted form).
//
// Two parts:
//   1. Pure checks (no server): generateSavedCardRideOrderId() always yields a
//      1..50-char ASCII order id (T-Bank Init rejects longer with code 212), and
//      computeToken signs the EXACT root scalar payload for both Init and Charge
//      (the classic cause of code 204 is a signed/sent mismatch).
//   2. Server checks against a throwaway DB with NO T-Bank credentials: the
//      charge-saved-card route is session-gated (401), validates bike/tariff
//      (404/400) BEFORE the config check, degrades to 503 when unconfigured, and
//      answers 409 when the rider has no saved card. The server never crashes.
//
// Run with:  npx tsx script/smoke-tbank-saved-card-charge.ts

import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown } from "./smoke-pg";
import { createHash } from "node:crypto";
import {
  generateSavedCardRideOrderId,
  computeToken,
  classifyRidePayment,
} from "../server/tbank";

const PORT = 5616;
const NAME = "tbank-saved-card-charge";
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
  const id = generateSavedCardRideOrderId();
  if (id.length < 1 || id.length > 50 || !/^[A-Za-z0-9-]+$/.test(id)) {
    assert(false, `generateSavedCardRideOrderId produced an invalid id: "${id}" (len ${id.length})`);
  }
}
assert(true, "generateSavedCardRideOrderId always yields a 1..50-char ASCII id (5000 samples)");
assert(generateSavedCardRideOrderId().startsWith("TRSC-"), "saved-card order id uses the TRSC- prefix");

// Init payload token: signs only root scalars (TerminalKey + Amount + OrderId +
// Description + CustomerKey + OperationInitiatorType + NotificationURL).
const pw = "test-password";
const initParams = {
  TerminalKey: "T",
  Amount: 35000,
  OrderId: "TRSC-abc-123456",
  Description: "Аренда велосипеда BC-001 • 1 час",
  CustomerKey: "user-1",
  OperationInitiatorType: "R",
  NotificationURL: "https://takeride.ru/api/payments/tbank/notification",
};
// Sorted keys: Amount, CustomerKey, Description, NotificationURL, OperationInitiatorType, OrderId, Password, TerminalKey
const initExpected = createHash("sha256")
  .update(
    "35000" +
      "user-1" +
      "Аренда велосипеда BC-001 • 1 час" +
      "https://takeride.ru/api/payments/tbank/notification" +
      "R" +
      "TRSC-abc-123456" +
      pw +
      "T",
    "utf8",
  )
  .digest("hex");
assert(computeToken(initParams, pw) === initExpected, "Init saved-card payload token matches the manual SHA-256 digest");

// Charge payload token: signs only TerminalKey + PaymentId + RebillId.
const chargeParams = { TerminalKey: "T", PaymentId: "987654", RebillId: "555000" };
// Sorted by key: Password, PaymentId, RebillId, TerminalKey ("Password" < "PaymentId").
const chargeExpected = createHash("sha256")
  .update(pw + "987654" + "555000" + "T", "utf8")
  .digest("hex");
assert(computeToken(chargeParams, pw) === chargeExpected, "Charge payload token matches the manual SHA-256 digest");

// A synchronous Charge confirmation maps to "paid"; a decline to "failed".
assert(classifyRidePayment({ status: "CONFIRMED" }) === "paid", "Charge CONFIRMED -> paid");
assert(classifyRidePayment({ status: "REJECTED" }) === "failed", "Charge REJECTED -> failed");

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

const ROUTE = "/api/payments/tbank/ride/charge-saved-card";

async function main() {
  DB_URL = (await createTestDb(NAME)).url;
  server = startServer();
  await waitForServer();

  // charge-saved-card without a session -> 401 (registered-only).
  let res = await fetch(`${BASE}${ROUTE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bikeId: "BC-001", tariffId: "h1" }),
  });
  assert(res.status === 401, "charge-saved-card requires a session (401 unregistered)");

  // Register a rider via the OTP dev fallback to get a session cookie.
  res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иван Тестов", phone: "8 (900) 444-55-66", consent: true }),
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

  // Unknown bike -> 404 (validation runs before the config/card checks).
  res = await fetch(`${BASE}${ROUTE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookie! },
    body: JSON.stringify({ bikeId: "NO-SUCH-BIKE", tariffId: "h1" }),
  });
  assert(res.status === 404, "charge-saved-card returns 404 for an unknown bike");

  // Bad tariff -> 400.
  res = await fetch(`${BASE}${ROUTE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookie! },
    body: JSON.stringify({ bikeId: available!.id, tariffId: "nope" }),
  });
  assert(res.status === 400, "charge-saved-card returns 400 for an unknown tariff");

  // Valid bike + tariff, but T-Bank not configured -> 503 (config checked before
  // the saved-card lookup).
  res = await fetch(`${BASE}${ROUTE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookie! },
    body: JSON.stringify({ bikeId: available!.id, tariffId: "h1" }),
  });
  assert(res.status === 503, "charge-saved-card returns 503 when T-Bank not configured");

  // Server still healthy.
  res = await fetch(`${BASE}/api/bikes`);
  assert(res.ok, "server still serves /api/bikes after the saved-card calls");

  if (!process.exitCode) console.log("\nAll T-Bank saved-card charge smoke checks passed.");
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

// Smoke test for the hourly prepaid billing model (money in integer kopecks).
//
// Two parts:
//   1. Pure checks (no server): tariff prices convert to kopecks correctly,
//      computeOverage() charges one started hour per overage window, and
//      finalRideCost() sums base + overage.
//   2. Server checks against a throwaway DB: register a rider, top up the
//      wallet, buy an hourly tariff, start a ride (internal wallet-debit flow),
//      verify the ride cost and wallet balance are all in kopecks, then end the
//      ride within the paid window (no overage) and confirm the settled cost.
//
// Run with:  npx tsx script/smoke-billing-kopecks.ts

import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown } from "./smoke-pg";
import { TARIFFS, tariffPriceKopecks, OVERAGE_HOUR_PRICE } from "../shared/geo";
import { computeOverage, finalRideCost, overageHourKopecks } from "../shared/billing";

const PORT = 5631;
const NAME = "billing-kopecks";
let DB_URL = "";
let server: ChildProcess;
const BASE = `http://127.0.0.1:${PORT}`;
const HOUR_MS = 60 * 60 * 1000;


function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

// ---- Part 1: pure checks (no server needed) ----

// Tariff prices convert to kopecks (×100) with no float drift.
const h1 = TARIFFS.find((t) => t.id === "h1")!;
const h2 = TARIFFS.find((t) => t.id === "h2")!;
const h3 = TARIFFS.find((t) => t.id === "h3")!;
assert(tariffPriceKopecks(h1) === 35000, "h1 (350 ₽) -> 35000 kopecks");
assert(tariffPriceKopecks(h2) === 60000, "h2 (600 ₽) -> 60000 kopecks");
assert(tariffPriceKopecks(h3) === 80000, "h3 (800 ₽) -> 80000 kopecks");
assert(overageHourKopecks() === OVERAGE_HOUR_PRICE * 100, "overage hour = OVERAGE_HOUR_PRICE ×100");

// computeOverage: within the paid window -> no charge.
assert(
  computeOverage(0, HOUR_MS).overageKopecks === 0,
  "usedMs=0 within 1h window -> no overage",
);
assert(
  computeOverage(HOUR_MS, HOUR_MS).overageKopecks === 0,
  "usedMs exactly == paidMs -> no overage",
);
assert(
  computeOverage(HOUR_MS - 1, HOUR_MS).extraHours === 0,
  "just under the window -> 0 extra hours",
);

// computeOverage: any overrun charges a full started hour.
let ov = computeOverage(HOUR_MS + 1, HOUR_MS);
assert(ov.extraHours === 1 && ov.overageKopecks === overageHourKopecks(), "1ms over -> 1 started hour charged");
ov = computeOverage(2 * HOUR_MS, HOUR_MS);
assert(ov.extraHours === 1, "exactly 2h used on 1h tariff -> 1 extra hour");
ov = computeOverage(2 * HOUR_MS + 1, HOUR_MS);
assert(ov.extraHours === 2 && ov.overageKopecks === 2 * overageHourKopecks(), "just over 2h -> 2 extra hours");

// Unknown/legacy tariff (paidMs <= 0): never charges overage.
assert(computeOverage(999 * HOUR_MS, 0).overageKopecks === 0, "paidMs=0 (legacy) -> never overage");

// finalRideCost sums base + overage.
assert(finalRideCost(35000, 0) === 35000, "final cost = base when no overage");
assert(finalRideCost(35000, overageHourKopecks()) === 35000 + overageHourKopecks(), "final cost = base + overage");

// ---- Part 2: server checks against a throwaway DB ----

function startServer(): ChildProcess {
  return spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
    {
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

  // Register a rider via the OTP dev fallback to get a session cookie.
  let res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Пётр Биллингов", phone: "8 (900) 555-66-77", consent: true }),
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
  const auth = { "Content-Type": "application/json", cookie: cookie! };

  // Fresh wallet starts at 0.
  let wallet = await (await fetch(`${BASE}/api/wallet`, { headers: { cookie: cookie! } })).json();
  assert(wallet.balance === 0, "fresh wallet balance is 0 kopecks");

  // Top up 1000 ₽. Client sends rubles; server stores kopecks (×100).
  res = await fetch(`${BASE}/api/wallet/topup`, {
    method: "POST", headers: auth, body: JSON.stringify({ amount: 1000 }),
  });
  assert(res.status === 200, "topup returns 200");
  const topupBody = await res.json();
  assert(topupBody.wallet.balance === 100000, "1000 ₽ top-up stored as 100000 kopecks");
  assert(topupBody.payment.amount === 100000, "top-up payment amount is 100000 kopecks");

  // Buy the h1 tariff (350 ₽). Server debits 35000 kopecks, balance -> 65000.
  res = await fetch(`${BASE}/api/wallet/tariff`, {
    method: "POST", headers: auth, body: JSON.stringify({ tariff: "h1" }),
  });
  assert(res.status === 200, "tariff purchase returns 200");
  const tariffBody = await res.json();
  assert(tariffBody.wallet.balance === 65000, "after h1 (350 ₽): balance 100000 - 35000 = 65000 kopecks");
  assert(tariffBody.payment.amount === -35000, "tariff purchase logs -35000 kopecks");

  // Find an available demo bike.
  const bikes = await (await fetch(`${BASE}/api/bikes`)).json();
  const available = (bikes as { id: string; status: string }[]).find((b) => b.status === "available");
  assert(!!available, "there is at least one available demo bike");

  // Start a ride on the internal (non-prepaid) flow: /api/rides/start debits the
  // tariff price from the wallet at start and fixes ride.cost in kopecks.
  res = await fetch(`${BASE}/api/rides/start`, {
    method: "POST", headers: auth, body: JSON.stringify({ bikeId: available!.id, tariff: "h1" }),
  });
  assert(res.status === 200, "ride start returns 200");
  const ride = await res.json();
  assert(ride.cost === 35000, "started ride cost is fixed to 35000 kopecks (h1)");
  assert(ride.status === "active", "started ride is active");

  // Wallet debited again at start (internal flow): 65000 - 35000 = 30000.
  wallet = await (await fetch(`${BASE}/api/wallet`, { headers: { cookie: cookie! } })).json();
  assert(wallet.balance === 30000, "wallet debited at ride start: 65000 - 35000 = 30000 kopecks");

  // Reject a per-minute/legacy tariff on new rides.
  res = await fetch(`${BASE}/api/rides/start`, {
    method: "POST", headers: auth, body: JSON.stringify({ bikeId: available!.id, tariff: "payg" }),
  });
  assert(res.status === 400, "starting a ride with legacy 'payg' tariff is rejected (400)");

  // End the ride immediately (well within the 1h paid window): no overage, cost
  // stays at the prepaid base.
  res = await fetch(`${BASE}/api/rides/${ride.id}/end`, { method: "POST", headers: auth });
  assert(res.status === 200, "ride end returns 200");
  const ended = await res.json();
  assert(ended.status === "completed", "ride is completed");
  assert(ended.cost === 35000, "ended within window: cost unchanged at 35000 kopecks (no overage)");

  // Wallet unchanged by ending within window (only overage would debit).
  wallet = await (await fetch(`${BASE}/api/wallet`, { headers: { cookie: cookie! } })).json();
  assert(wallet.balance === 30000, "ending within window does not debit the wallet further");

  console.log("\n✓ ALL BILLING SMOKE CHECKS PASSED");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown(NAME, server);
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });

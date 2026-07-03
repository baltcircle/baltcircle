// Smoke test for the admin period-scoped analytics API (Аналитика v1).
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) and ADMIN_PHONE_NUMBERS set. Then:
//   1. registers an admin and a plain rider
//   2. asserts /api/admin/analytics requires staff (401 unauth, 403 rider)
//   3. has the rider complete a ride, then asserts the admin analytics payload
//      reports it within a window covering "now" and excludes it from a future
//      window (seed data fills the past, so emptiness is checked in the future)
//   4. asserts the response carries the expected KPI / section shape
//   5. asserts an inverted from/to range returns 400
//
// Run with:  npx tsx script/smoke-admin-analytics.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown } from "./smoke-pg";

const PORT = 5611;
const NAME = "admin-analytics";
let DB_URL = "";
let server: ChildProcess;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PHONE = "+79991112277";


function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
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

async function register(name: string, phone: string): Promise<{ cookie: string; user: any }> {
  let res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, phone, consent: true }),
  });
  if (res.status !== 200) throw new Error(`otp/start failed for ${phone}: ${res.status}`);
  const start = await res.json();
  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: start.phone, code: start.devCode }),
  });
  if (res.status !== 201) throw new Error(`otp/verify failed for ${phone}: ${res.status}`);
  const user = await res.json();
  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"))!;
  return { cookie, user };
}

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
      ADMIN_PHONE_NUMBERS: ADMIN_PHONE,
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
  );
}

const j = (cookie: string, method: string, url: string, body?: any) =>
  fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function main() {
  DB_URL = (await createTestDb(NAME)).url;
  server = startServer();
  await waitForServer();

  const admin = await register("Админ", ADMIN_PHONE);
  assert(admin.user.role === "admin", "admin phone is promoted to role=admin");
  const rider = await register("Райдер Тест", "+79005550044");
  assert(rider.user.role === "rider", "ordinary phone registers as role=rider");

  // 2. Access control on the endpoint.
  let res = await fetch(`${BASE}/api/admin/analytics`);
  assert(res.status === 401, "GET /api/admin/analytics without session returns 401");
  res = await fetch(`${BASE}/api/admin/analytics`, { headers: { cookie: rider.cookie } });
  assert(res.status === 403, "rider cannot read admin analytics (403)");

  // 3. Rider completes a ride so it shows up in the period aggregates.
  const bikes = await (await fetch(`${BASE}/api/bikes`)).json();
  const available = bikes.find((b: any) => b.status === "available");
  assert(!!available, "a seeded available bike exists to rent");
  // Hourly prepaid model: internal start debits the tariff price at start,
  // so the rider needs funds and must pick a valid hourly tariff (h1/h2/h3).
  res = await j(rider.cookie, "POST", "/api/wallet/topup", { amount: 1000 });
  assert(res.status === 200, "rider tops up wallet (200)");
  res = await j(rider.cookie, "POST", "/api/rides/start", { bikeId: available.id, tariff: "h1" });
  assert(res.status === 200, "rider starts a ride (200)");
  const ride = await res.json();
  res = await j(admin.cookie, "POST", `/api/admin/rides/${ride.id}/end`, {});
  assert(res.status === 200, "admin ends the ride (200)");

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // 4. Window covering "now" includes the ride and carries the expected shape.
  res = await fetch(
    `${BASE}/api/admin/analytics?from=${now - dayMs}&to=${now + dayMs}`,
    { headers: { cookie: admin.cookie } },
  );
  assert(res.status === 200, "admin can read period analytics (200)");
  const a = await res.json();
  assert(a && a.kpis && typeof a.kpis.ridesCount === "number", "payload has kpis.ridesCount");
  assert(a.kpis.ridesCount >= 1, "current window counts the completed ride");
  assert(a.kpis.completedRides >= 1, "current window counts a completed ride");
  assert(a.kpis.usersWithRides >= 1, "current window reports at least one user with rides");
  assert(Array.isArray(a.topBikes), "payload has topBikes array");
  assert(Array.isArray(a.zeroRideBikes), "payload has zeroRideBikes array");
  assert(a.usersSummary && typeof a.usersSummary.total === "number", "payload has usersSummary.total");
  assert(a.service && Array.isArray(a.service.byPriority), "payload has service.byPriority array");
  assert(a.service && Array.isArray(a.service.byStatus), "payload has service.byStatus array");
  assert(Array.isArray(a.parkingUsage), "payload has parkingUsage array");
  assert(Array.isArray(a.byDay), "payload has byDay array");
  const rentedBike = a.topBikes.find((b: any) => b.id === available.id);
  assert(rentedBike && rentedBike.rides >= 1, "the rented bike appears in topBikes with rides>=1");

  // 5. A future window (after now) contains no rides — proves period scoping
  //    actually bounds the aggregates (seed data fills the past, so an empty
  //    window has to be sought in the future).
  res = await fetch(
    `${BASE}/api/admin/analytics?from=${now + 10 * dayMs}&to=${now + 20 * dayMs}`,
    { headers: { cookie: admin.cookie } },
  );
  assert(res.status === 200, "admin reads a future window (200)");
  const future = await res.json();
  assert(future.kpis.ridesCount === 0, "future window has no rides (ridesCount 0)");
  assert(future.kpis.revenue === 0, "future window has no revenue");

  // 6. Inverted range is rejected.
  res = await fetch(
    `${BASE}/api/admin/analytics?from=${now}&to=${now - dayMs}`,
    { headers: { cookie: admin.cookie } },
  );
  assert(res.status === 400, "inverted from/to range returns 400");

  console.log("\nAll admin analytics smoke checks passed.");
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

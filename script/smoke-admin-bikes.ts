// Smoke test for the admin fleet (bike) management API.
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) and ADMIN_PHONE_NUMBERS set. Then:
//   1. registers an admin and a plain rider
//   2. asserts /api/admin/bikes requires staff (401 unauth, 403 rider)
//   3. asserts the 5 demo bikes are present
//   4. creates a real bike and asserts it persists with the right fields
//   5. rejects a duplicate id (409) and a bad id (400)
//   6. edits the bike (model/status/notes/lock id)
//   7. asserts a non-available bike is refused for rental
//   8. archives a bike → drops out of public /api/bikes but stays in admin list
//   9. deletes a never-ridden bike (hard delete) and a ridden one (→ archive)
//
// Run with:  npx tsx script/smoke-admin-bikes.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown } from "./smoke-pg";

const PORT = 5603;
const NAME = "admin-bikes";
let DB_URL = "";
let server: ChildProcess;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PHONE = "+79991112255";


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
  const rider = await register("Райдер", "+79005550022");
  assert(rider.user.role === "rider", "ordinary phone registers as role=rider");

  // 2. Access control.
  let res = await fetch(`${BASE}/api/admin/bikes`);
  assert(res.status === 401, "GET /api/admin/bikes without session returns 401");
  res = await fetch(`${BASE}/api/admin/bikes`, { headers: { cookie: rider.cookie } });
  assert(res.status === 403, "rider cannot list admin bikes (403)");

  // 3. Demo fleet present.
  res = await fetch(`${BASE}/api/admin/bikes`, { headers: { cookie: admin.cookie } });
  assert(res.status === 200, "admin can list bikes (200)");
  const demoList = await res.json();
  assert(Array.isArray(demoList) && demoList.length === 5, "5 demo bikes are seeded");

  // 4. Create a real bike.
  res = await j(admin.cookie, "POST", "/api/admin/bikes", {
    id: "bc-900", model: "BC City+", status: "available", battery: 88,
    serial: "SN-900", lockId: "LOCK-900", notes: "Тестовый",
  });
  assert(res.status === 201, "admin creates a bike (201)");
  const created = await res.json();
  assert(created.id === "BC-900", "id is upper-cased to BC-900");
  assert(created.serial === "SN-900" && created.lockId === "LOCK-900", "serial + lock id persisted");
  assert(created.seed === false || created.seed === 0, "created bike is not a demo seed row");

  // 5. Duplicate + bad id.
  res = await j(admin.cookie, "POST", "/api/admin/bikes", { id: "BC-900", model: "X" });
  assert(res.status === 409, "duplicate id rejected (409)");
  res = await j(admin.cookie, "POST", "/api/admin/bikes", { id: "bad id!", model: "X" });
  assert(res.status === 400, "invalid id rejected (400)");

  // 6. Edit it.
  res = await j(admin.cookie, "PATCH", "/api/admin/bikes/BC-900", {
    model: "BC Cruiser", status: "maintenance", notes: "На ремонте",
  });
  assert(res.status === 200, "admin edits the bike (200)");
  const edited = await res.json();
  assert(edited.model === "BC Cruiser" && edited.status === "maintenance", "edits persisted");

  // 7. A maintenance bike cannot be rented.
  res = await j(rider.cookie, "POST", "/api/rides/start", { bikeId: "BC-900" });
  assert(res.status === 400, "maintenance bike refused for rental (400)");

  // 8. Archive a demo bike → gone from public list, present in admin list.
  res = await j(admin.cookie, "POST", "/api/admin/bikes/BC-001/archive");
  assert(res.status === 200, "admin archives BC-001 (200)");
  const publicBikes = await (await fetch(`${BASE}/api/bikes`)).json();
  assert(!publicBikes.some((b: any) => b.id === "BC-001"), "archived bike hidden from public /api/bikes");
  const adminBikes = await (await fetch(`${BASE}/api/admin/bikes`, { headers: { cookie: admin.cookie } })).json();
  assert(adminBikes.some((b: any) => b.id === "BC-001" && b.status === "archived"), "archived bike visible to admin");

  // Archived bike cannot be rented.
  res = await j(rider.cookie, "POST", "/api/rides/start", { bikeId: "BC-001" });
  assert(res.status === 400, "archived bike refused for rental (400)");

  // 9a. Hard delete a never-ridden bike (BC-900 has no rides).
  res = await j(admin.cookie, "DELETE", "/api/admin/bikes/BC-900");
  assert(res.status === 200, "never-ridden bike hard-deleted (200)");
  res = await fetch(`${BASE}/api/bikes/BC-900`);
  assert(res.status === 404, "deleted bike is gone (404)");

  // 9b. Delete a demo bike that has ride history → archived instead (409).
  const ridden = (await (await fetch(`${BASE}/api/admin/bikes`, { headers: { cookie: admin.cookie } })).json())
    .find((b: any) => b.seed && b.status !== "archived");
  assert(!!ridden, "a ridden demo bike exists to test soft-delete");
  res = await j(admin.cookie, "DELETE", `/api/admin/bikes/${ridden.id}`);
  assert(res.status === 409, "ridden bike delete is refused and archived (409)");
  res = await fetch(`${BASE}/api/bikes/${ridden.id}`);
  const stillThere = await res.json();
  assert(stillThere.status === "archived", "ridden bike was archived, not removed");

  console.log("\nAll admin bikes smoke checks passed.");
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

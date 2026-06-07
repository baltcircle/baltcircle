// Smoke test for the admin users-management API.
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) and ADMIN_PHONE_NUMBERS set to the admin phone. Then:
//   1. registers an admin (phone in ADMIN_PHONE_NUMBERS) and a plain rider
//   2. asserts GET /api/admin/users requires staff (401 unauth, 403 for rider)
//   3. asserts the admin sees both users in the list
//   4. promotes the rider to operator and asserts persistence
//   5. asserts a non-admin operator cannot grant the admin role (403)
//   6. blocks the rider, asserts blockedAt is set and ride start is refused
//   7. unblocks and asserts ride start is allowed again
//
// Run with:  npx tsx script/smoke-admin-users.ts
import { rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 5602;
const DB_PATH = "/tmp/bc-smoke-admin-users.db";
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PHONE = "+79991112233";

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

// Register a user via OTP and return its session cookie + created user.
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

const server = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
  {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(PORT),
      DATABASE_PATH: DB_PATH,
      SMS_PROVIDER: "",
      ADMIN_PHONE_NUMBERS: ADMIN_PHONE,
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);

async function main() {
  await waitForServer();

  // 1. Register an admin (env-promoted) and a plain rider.
  const admin = await register("Админ", "8 999 111-22-33");
  assert(admin.user.role === "admin", "admin phone is promoted to role=admin");
  const rider = await register("Райдер Тест", "+79005550011");
  assert(rider.user.role === "rider", "ordinary phone registers as role=rider");

  // 2. Access control on the list endpoint.
  let res = await fetch(`${BASE}/api/admin/users`);
  assert(res.status === 401, "GET /api/admin/users without session returns 401");

  res = await fetch(`${BASE}/api/admin/users`, { headers: { cookie: rider.cookie } });
  assert(res.status === 403, "rider cannot list users (403)");

  res = await fetch(`${BASE}/api/admin/users`, { headers: { cookie: admin.cookie } });
  assert(res.status === 200, "admin can list users (200)");
  const list = await res.json();
  assert(Array.isArray(list) && list.length === 2, "list returns both registered users");
  const listed = list.find((u: any) => u.id === rider.user.id);
  assert(!!listed && "consentAcceptedAt" in listed && "createdAt" in listed,
    "list rows include consent + registration metadata");

  // 3. Admin promotes the rider to operator.
  res = await fetch(`${BASE}/api/admin/users/${rider.user.id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role: "operator" }),
  });
  assert(res.status === 200, "admin promotes rider to operator (200)");
  const promoted = await res.json();
  assert(promoted.role === "operator", "role persisted as operator");

  // 4. The now-operator rider cannot grant the admin role.
  res = await fetch(`${BASE}/api/admin/users/${rider.user.id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: rider.cookie },
    body: JSON.stringify({ role: "admin" }),
  });
  assert(res.status === 403, "operator cannot grant the admin role (403)");

  // 5. Admin cannot demote themselves.
  res = await fetch(`${BASE}/api/admin/users/${admin.user.id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role: "rider" }),
  });
  assert(res.status === 400, "admin cannot demote themselves (400)");

  // 6. Block the rider and assert ride start is refused.
  res = await fetch(`${BASE}/api/admin/users/${rider.user.id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ blocked: true, reason: "Тест блокировки" }),
  });
  assert(res.status === 200, "admin blocks the rider (200)");
  const blocked = await res.json();
  assert(typeof blocked.blockedAt === "number", "blockedAt timestamp is set");
  assert(blocked.blockedReason === "Тест блокировки", "blockedReason is stored");

  const bikes = await (await fetch(`${BASE}/api/bikes`)).json();
  const bikeId = bikes[0]?.id;
  assert(!!bikeId, "a demo bike exists to attempt a rental");
  res = await fetch(`${BASE}/api/rides/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: rider.cookie },
    body: JSON.stringify({ bikeId }),
  });
  assert(res.status === 403, "blocked account cannot start a ride (403)");

  // 7. Unblock and assert the ride can start.
  res = await fetch(`${BASE}/api/admin/users/${rider.user.id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ blocked: false }),
  });
  assert(res.status === 200, "admin unblocks the rider (200)");
  const unblocked = await res.json();
  assert(unblocked.blockedAt === null, "blockedAt cleared on unblock");

  res = await fetch(`${BASE}/api/rides/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: rider.cookie },
    body: JSON.stringify({ bikeId }),
  });
  assert(res.status === 200, "unblocked account can start a ride (200)");

  console.log("\nAll admin users smoke checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill("SIGTERM");
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });

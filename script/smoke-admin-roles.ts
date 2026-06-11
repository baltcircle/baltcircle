// Smoke test for the mechanic staff role and its access boundaries.
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) and ADMIN_PHONE_NUMBERS set to the admin phone. Then:
//   1. registers an admin (env-promoted), a plain rider, and a second rider
//      that the admin promotes to "mechanic"
//   2. asserts an operator/admin can assign the mechanic role, and that the
//      adminSetRole schema accepts it (persisted as role=mechanic)
//   3. asserts a mechanic CAN work service tickets (create / patch / comment)
//   4. asserts a mechanic CANNOT reach operator/admin-only surfaces
//      (users list, admin bikes write, admin rides) → 403
//   5. asserts a mechanic CAN read the admin fleet list (read-only fleet)
//   6. asserts a mechanic cannot grant the admin role (403)
//
// Run with:  npx tsx script/smoke-admin-roles.ts
import { rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 5608;
const DB_PATH = "/tmp/bc-smoke-admin-roles.db";
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PHONE = "+79991113344";

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
      API_ONLY: "1",
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

  // 1. Register an admin (env-promoted), a rider, and a future mechanic.
  const admin = await register("Админ", "8 999 111-33-44");
  assert(admin.user.role === "admin", "admin phone is promoted to role=admin");
  const rider = await register("Райдер", "+79005550022");
  assert(rider.user.role === "rider", "ordinary phone registers as role=rider");
  const mech = await register("Механик Тест", "+79005550033");
  assert(mech.user.role === "rider", "future mechanic starts as a rider");

  // 2. Admin assigns the mechanic role (schema accepts it; it persists).
  let res = await fetch(`${BASE}/api/admin/users/${mech.user.id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ role: "mechanic" }),
  });
  assert(res.status === 200, "admin assigns the mechanic role (200)");
  const promoted = await res.json();
  assert(promoted.role === "mechanic", "role persisted as mechanic");

  // A grab a demo bike id for ticket work.
  const bikes = await (await fetch(`${BASE}/api/bikes`)).json();
  const bikeId = bikes[0]?.id;
  assert(!!bikeId, "a demo bike exists for ticket work");

  // 3. A mechanic CAN create / patch / comment on service tickets.
  res = await fetch(`${BASE}/api/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: mech.cookie },
    body: JSON.stringify({ bikeId, kind: "brakes", priority: "medium", message: "Скрипят тормоза" }),
  });
  assert(res.status === 201, "mechanic creates a service ticket (201)");
  const ticket = await res.json();

  res = await fetch(`${BASE}/api/tickets/${ticket.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: mech.cookie },
    body: JSON.stringify({ status: "in_progress" }),
  });
  assert(res.status === 200, "mechanic updates a ticket status (200)");

  res = await fetch(`${BASE}/api/tickets/${ticket.id}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: mech.cookie },
    body: JSON.stringify({ body: "Взял в работу" }),
  });
  assert(res.status === 201, "mechanic comments on a ticket (201)");

  // A plain rider still cannot mutate tickets (guard intact).
  res = await fetch(`${BASE}/api/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: rider.cookie },
    body: JSON.stringify({ bikeId, kind: "other", message: "Должно быть отклонено" }),
  });
  assert(res.status === 403, "rider cannot create a service ticket (403)");

  // 4. A mechanic CANNOT reach operator/admin-only surfaces.
  res = await fetch(`${BASE}/api/admin/users`, { headers: { cookie: mech.cookie } });
  assert(res.status === 403, "mechanic cannot list users (403)");

  res = await fetch(`${BASE}/api/admin/rides`, { headers: { cookie: mech.cookie } });
  assert(res.status === 403, "mechanic cannot read admin rides (403)");

  res = await fetch(`${BASE}/api/admin/bikes/${bikeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: mech.cookie },
    body: JSON.stringify({ notes: "не должно пройти" }),
  });
  assert(res.status === 403, "mechanic cannot write to the admin fleet (403)");

  // 5. A mechanic CAN read the admin fleet list (read-only fleet access).
  res = await fetch(`${BASE}/api/admin/bikes`, { headers: { cookie: mech.cookie } });
  assert(res.status === 200, "mechanic can read the admin fleet list (200)");

  // 6. A mechanic cannot grant the admin role.
  res = await fetch(`${BASE}/api/admin/users/${rider.user.id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: mech.cookie },
    body: JSON.stringify({ role: "admin" }),
  });
  assert(res.status === 403, "mechanic cannot grant the admin role (403)");

  console.log("\nAll mechanic role smoke checks passed.");
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

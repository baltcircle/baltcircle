// Smoke test for the admin parking management API.
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) and ADMIN_PHONE_NUMBERS set. Then:
//   1. registers an admin and a plain rider
//   2. asserts /api/admin/parkings requires staff (401 unauth, 403 rider)
//   3. asserts the 15 demo parkings are present and public /api/parkings is active-only
//   4. creates a parking (auto id) and one with an explicit id; persists fields
//   5. rejects a duplicate id (409) and bad input (400)
//   6. edits a parking (name/status/capacity/occupied/notes) and clamps occupied
//   7. inactive parking drops out of public /api/parkings but stays in admin list
//   8. archives a parking → hidden from public + the admin map render set
//   8b. restores it → comes back inactive, hidden from public, on admin map
//   9. hard-deletes a never-referenced parking (200) → gone
//
// Run with:  npx tsx script/smoke-admin-parkings.ts
import { rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 5608;
const DB_PATH = "/tmp/bc-smoke-admin-parkings.db";
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PHONE = "+79991112277";

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
      const res = await fetch(`${BASE}/api/parkings`);
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

const j = (cookie: string, method: string, url: string, body?: any) =>
  fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function main() {
  await waitForServer();

  const admin = await register("Админ", ADMIN_PHONE);
  assert(admin.user.role === "admin", "admin phone is promoted to role=admin");
  const rider = await register("Райдер", "+79005550077");
  assert(rider.user.role === "rider", "ordinary phone registers as role=rider");

  // 2. Access control.
  let res = await fetch(`${BASE}/api/admin/parkings`);
  assert(res.status === 401, "GET /api/admin/parkings without session returns 401");
  res = await fetch(`${BASE}/api/admin/parkings`, { headers: { cookie: rider.cookie } });
  assert(res.status === 403, "rider cannot list admin parkings (403)");

  // 3. Demo parkings present + public list is active-only.
  res = await fetch(`${BASE}/api/admin/parkings`, { headers: { cookie: admin.cookie } });
  assert(res.status === 200, "admin can list parkings (200)");
  const demoList = await res.json();
  assert(Array.isArray(demoList) && demoList.length === 15, "15 demo parkings are seeded");
  const publicSeed = await (await fetch(`${BASE}/api/parkings`)).json();
  assert(publicSeed.length === 15, "public /api/parkings returns the 15 active demo points");

  // 4. Create with auto id, then with explicit id.
  res = await j(admin.cookie, "POST", "/api/admin/parkings", {
    name: "Тестовая авто", lat: 54.945, lng: 20.275, capacity: 12, occupied: 3, status: "active",
  });
  assert(res.status === 201, "admin creates a parking with auto id (201)");
  const auto = await res.json();
  assert(/^P-\d{2}$/.test(auto.id), `auto id matches P-NN (got ${auto.id})`);
  assert(auto.seed === false || auto.seed === 0, "created parking is not a demo seed row");

  res = await j(admin.cookie, "POST", "/api/admin/parkings", {
    id: "px-test", name: "Тестовая ручная", lat: 54.943, lng: 20.22,
    capacity: 8, occupied: 0, status: "inactive", notes: "Заметка",
  });
  assert(res.status === 201, "admin creates a parking with explicit id (201)");
  const manual = await res.json();
  assert(manual.id === "PX-TEST", "explicit id is upper-cased to PX-TEST");
  assert(manual.status === "inactive" && manual.notes === "Заметка", "status + notes persisted");

  // 5. Duplicate + bad input.
  res = await j(admin.cookie, "POST", "/api/admin/parkings", {
    id: "PX-TEST", name: "Дубликат", lat: 54.9, lng: 20.2,
  });
  assert(res.status === 409, "duplicate id rejected (409)");
  res = await j(admin.cookie, "POST", "/api/admin/parkings", {
    name: "X", lat: 54.9, lng: 20.2,
  });
  assert(res.status === 400, "too-short name rejected (400)");

  // 6. Edit + occupied clamp.
  res = await j(admin.cookie, "PATCH", `/api/admin/parkings/${auto.id}`, {
    name: "Переименована", status: "active", capacity: 5, occupied: 99, notes: "Обновлено",
  });
  assert(res.status === 200, "admin edits the parking (200)");
  const edited = await res.json();
  assert(edited.name === "Переименована" && edited.capacity === 5, "name + capacity edits persisted");
  assert(edited.occupied === 5, "occupied is clamped to capacity");
  res = await j(admin.cookie, "PATCH", "/api/admin/parkings/DOES-NOT-EXIST", { name: "Нет" });
  assert(res.status === 404, "patch on missing parking returns 404");

  // 7. Inactive parking is hidden from public list, present for admin.
  const publicList = await (await fetch(`${BASE}/api/parkings`)).json();
  assert(!publicList.some((p: any) => p.id === "PX-TEST"), "inactive parking hidden from public /api/parkings");
  const adminList = await (await fetch(`${BASE}/api/admin/parkings`, { headers: { cookie: admin.cookie } })).json();
  assert(adminList.some((p: any) => p.id === "PX-TEST"), "inactive parking visible to admin");
  // The admin maps (parking + route/zone editors) render the non-archived
  // subset of this list, dimming inactive points. Assert the inactive point is
  // exactly that — present, inactive, and not archived — so it reaches the map.
  const inactiveOnMap = adminList.find(
    (p: any) => p.id === "PX-TEST" && p.status === "inactive" && !p.archivedAt,
  );
  assert(!!inactiveOnMap, "inactive non-archived parking is in the admin map render set");
  // The admin map render set (non-archived parkings) must strictly contain the
  // public, active-only set: every public parking is also on the admin map, and
  // the admin map additionally carries the inactive point that the public map
  // omits. This is the active-only-vs-full-list contract the bug violated.
  const publicNow = await (await fetch(`${BASE}/api/parkings`)).json();
  const adminMapSet = adminList.filter((p: any) => !p.archivedAt);
  const adminMapIds = new Set(adminMapSet.map((p: any) => p.id));
  assert(
    publicNow.every((p: any) => p.status === "active"),
    "public /api/parkings is active-only",
  );
  assert(
    publicNow.every((p: any) => adminMapIds.has(p.id)),
    "every public parking is also on the admin map",
  );
  assert(
    adminMapSet.some((p: any) => p.status === "inactive") &&
      !publicNow.some((p: any) => p.status === "inactive"),
    "admin map shows inactive parkings the public map hides",
  );

  // 8. Archive a demo parking → gone from both lists.
  res = await j(admin.cookie, "POST", "/api/admin/parkings/P-01/archive");
  assert(res.status === 200, "admin archives P-01 (200)");
  const publicAfter = await (await fetch(`${BASE}/api/parkings`)).json();
  assert(!publicAfter.some((p: any) => p.id === "P-01"), "archived parking hidden from public list");
  const adminAfter = await (await fetch(`${BASE}/api/admin/parkings`, { headers: { cookie: admin.cookie } })).json();
  assert(adminAfter.some((p: any) => p.id === "P-01" && p.archivedAt), "archived parking carries archivedAt in admin list");

  // 8b. Restore the archived parking → returns as inactive, never re-appears on
  // the public map, and lands back in the admin map render set (non-archived).
  res = await j(admin.cookie, "POST", "/api/admin/parkings/P-01/restore");
  assert(res.status === 200, "admin restores archived P-01 (200)");
  const restored = await res.json();
  assert(!restored.archivedAt, "restored parking has archivedAt cleared");
  assert(restored.status === "inactive", "restored parking comes back as inactive (not auto-shown to riders)");
  const publicAfterRestore = await (await fetch(`${BASE}/api/parkings`)).json();
  assert(!publicAfterRestore.some((p: any) => p.id === "P-01"), "restored-as-inactive parking stays hidden from public map");
  const adminAfterRestore = await (await fetch(`${BASE}/api/admin/parkings`, { headers: { cookie: admin.cookie } })).json();
  const restoredOnMap = adminAfterRestore.find(
    (p: any) => p.id === "P-01" && p.status === "inactive" && !p.archivedAt,
  );
  assert(!!restoredOnMap, "restored parking is back in the admin map render set, muted as inactive");
  // Restoring a live (non-archived) parking is rejected.
  res = await j(admin.cookie, "POST", "/api/admin/parkings/P-01/restore");
  assert(res.status === 404, "restoring a non-archived parking is rejected (404)");
  res = await j(admin.cookie, "POST", "/api/admin/parkings/DOES-NOT-EXIST/restore");
  assert(res.status === 404, "restoring a missing parking returns 404");

  // 9. Hard-delete an unreferenced parking → fully removed.
  res = await j(admin.cookie, "DELETE", `/api/admin/parkings/${auto.id}`);
  assert(res.status === 200, "unreferenced parking hard-deleted (200)");
  const finalList = await (await fetch(`${BASE}/api/admin/parkings`, { headers: { cookie: admin.cookie } })).json();
  assert(!finalList.some((p: any) => p.id === auto.id), "hard-deleted parking is gone from admin list");

  console.log("\nAll admin parkings smoke checks passed.");
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

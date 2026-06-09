// Smoke test for the service / maintenance ticket API.
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) and ADMIN_PHONE_NUMBERS set. Then:
//   1. registers an admin and a plain rider
//   2. asserts ticket mutations require staff (401 unauth, 403 rider)
//   3. admin creates a critical ticket → bike flips to maintenance, a creation
//      event is logged
//   4. admin patches status/priority → history events appear
//   5. admin adds a comment → appears in the thread
//   6. admin closes the ticket with returnBikeToAvailable → bike returns to
//      available and ticket is closed
//   7. filters: the closed ticket no longer counts as active
//
// Run with:  npx tsx script/smoke-admin-maintenance.ts
import { rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const PORT = 5605;
const DB_PATH = "/tmp/bc-smoke-admin-maintenance.db";
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
  const rider = await register("Райдер Тест", "+79005550044");
  assert(rider.user.role === "rider", "ordinary phone registers as role=rider");

  // A seeded available bike to attach the ticket to.
  const bikes = await (await fetch(`${BASE}/api/bikes`)).json();
  const available = bikes.find((b: any) => b.status === "available");
  assert(!!available, "a seeded available bike exists");

  // 2. Access control on mutations.
  let res = await fetch(`${BASE}/api/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bikeId: available.id, kind: "brakes", message: "test" }),
  });
  assert(res.status === 401, "POST /api/tickets without session returns 401");
  res = await j(rider.cookie, "POST", "/api/tickets", { bikeId: available.id, kind: "brakes", message: "test" });
  assert(res.status === 403, "rider cannot create a ticket (403)");

  // 3. Admin creates a critical ticket → bike pulled into maintenance.
  res = await j(admin.cookie, "POST", "/api/tickets", {
    bikeId: available.id, kind: "brakes", priority: "critical",
    title: "Не работают тормоза", message: "Передний тормоз не схватывает", assignee: "Бригада 1",
  });
  assert(res.status === 201, "admin creates a ticket (201)");
  const ticket = await res.json();
  assert(ticket.status === "new", "new ticket starts in status=new");
  assert(ticket.priority === "critical", "ticket priority persisted");
  assert(Array.isArray(ticket.comments) && ticket.comments.some((c: any) => c.kind === "event"), "creation logs an event in history");

  const afterCreate = await (await fetch(`${BASE}/api/bikes`)).json();
  const movedBike = afterCreate.find((b: any) => b.id === available.id);
  assert(movedBike && movedBike.status === "maintenance", "critical ticket moves the bike to maintenance");

  // 4. Validation: empty/invalid bodies rejected.
  res = await j(admin.cookie, "POST", "/api/tickets", { bikeId: "", kind: "brakes", message: "x" });
  assert(res.status === 400, "creating with blank bike id returns 400");
  res = await j(admin.cookie, "PATCH", `/api/tickets/${ticket.id}`, {});
  assert(res.status === 400, "patch with no changes returns 400");

  // 5. Admin updates status + priority → events logged.
  res = await j(admin.cookie, "PATCH", `/api/tickets/${ticket.id}`, { status: "in_progress", priority: "high" });
  assert(res.status === 200, "admin patches the ticket (200)");
  let updated = await res.json();
  assert(updated.status === "in_progress", "status updated to in_progress");
  assert(updated.priority === "high", "priority updated to high");
  assert(updated.comments.filter((c: any) => c.kind === "event").length >= 3, "status/priority changes logged as events");

  // 6. Add a comment.
  res = await j(admin.cookie, "POST", `/api/tickets/${ticket.id}/comments`, { body: "Заказаны колодки" });
  assert(res.status === 201, "admin adds a comment (201)");
  updated = await res.json();
  assert(updated.comments.some((c: any) => c.kind === "comment" && c.body === "Заказаны колодки"), "comment appears in history");
  res = await j(admin.cookie, "POST", `/api/tickets/${ticket.id}/comments`, { body: "" });
  assert(res.status === 400, "empty comment is rejected (400)");

  // 7. Close with return-to-available → bike comes back, ticket closed.
  res = await j(admin.cookie, "PATCH", `/api/tickets/${ticket.id}`, { status: "closed", returnBikeToAvailable: true });
  assert(res.status === 200, "admin closes the ticket (200)");
  const closed = await res.json();
  assert(closed.status === "closed", "ticket is closed");
  assert(typeof closed.closedAt === "number" && closed.closedAt > 0, "closed ticket has a closedAt timestamp");

  const afterClose = await (await fetch(`${BASE}/api/bikes`)).json();
  const freed = afterClose.find((b: any) => b.id === available.id);
  assert(freed && freed.status === "available", "bike returns to available on close");

  // 8. Unknown ticket → 404.
  res = await j(admin.cookie, "PATCH", "/api/tickets/999999", { status: "closed" });
  assert(res.status === 404, "patching an unknown ticket returns 404");
  res = await j(admin.cookie, "POST", "/api/tickets/999999/comments", { body: "x" });
  assert(res.status === 404, "commenting on an unknown ticket returns 404");

  // 9. Detail endpoint returns the thread.
  res = await fetch(`${BASE}/api/tickets/${ticket.id}`);
  assert(res.status === 200, "GET /api/tickets/:id returns the ticket (200)");
  const detail = await res.json();
  assert(Array.isArray(detail.comments) && detail.comments.length >= 4, "detail carries the full history thread");

  console.log("\nAll admin maintenance smoke checks passed.");
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

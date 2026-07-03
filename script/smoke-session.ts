// Smoke test for Postgres-backed session persistence across server restarts.
//
// Boots the real Express server against a throwaway Postgres DB, registers a
// rider via the OTP dev fallback to obtain a session cookie, then:
//   1. confirms the cookie resolves /api/users/current to the created user
//   2. asserts a row exists in the `session` table (connect-pg-simple)
//   3. SIGTERMs the server and starts a fresh process against the SAME DB
//   4. confirms the SAME cookie still resolves to the SAME user after restart
//      (this is what in-memory storage failed to do)
//
// Run with:  npx tsx script/smoke-session.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown, openTestDb } from "./smoke-pg";

const NAME = "session";
const PORT = 5601;
const BASE = `http://127.0.0.1:${PORT}`;
let DB_URL = "";
let server: ChildProcess;

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
      env: { ...process.env, NODE_ENV: "development", API_ONLY: "1", PORT: String(PORT), DATABASE_URL: DB_URL, SMS_PROVIDER: "" },
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

  // Register a rider via the OTP dev fallback to obtain a real session.
  let res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иван Тестов", phone: "8 (900) 765-43-21", consent: true }),
  });
  assert(res.status === 200, "otp start returns 200");
  const startBody = await res.json();

  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: startBody.phone, code: startBody.devCode }),
  });
  assert(res.status === 201, "otp verify returns 201");
  const created = await res.json();
  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"));
  assert(!!cookie, "verify sets a session cookie");

  // Session resolves before restart.
  res = await fetch(`${BASE}/api/users/current`, { headers: { cookie: cookie! } });
  let body = await res.json();
  assert(body && body.id === created.id, "session resolves to user before restart");

  // A session row is persisted in the same Postgres DB.
  const sdb = await openTestDb(DB_URL);
  const sessRow = (await sdb.prepare("SELECT sid, sess, expire FROM session LIMIT 1").get()) as
    | { sid: string; sess: unknown; expire: unknown }
    | undefined;
  await sdb.close();
  assert(!!sessRow, "a row exists in the session table");
  const sess = typeof sessRow!.sess === "string" ? JSON.parse(sessRow!.sess) : sessRow!.sess;
  assert((sess as { userId?: string }).userId === created.id, "persisted session stores the rider's userId");

  // Restart the server against the same DB.
  await stop(server);
  server = startServer();
  await waitForServer();

  // The SAME cookie must still resolve to the SAME user after restart.
  res = await fetch(`${BASE}/api/users/current`, { headers: { cookie: cookie! } });
  body = await res.json();
  assert(body && body.id === created.id, "session survives server restart (same cookie -> same user)");

  console.log("\nAll session-persistence smoke checks passed.");
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

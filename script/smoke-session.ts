// Smoke test for SQLite-backed session persistence across server restarts.
//
// Boots the real Express server against a throwaway SQLite DB, registers a
// rider via the OTP dev fallback to obtain a session cookie, then:
//   1. confirms the cookie resolves /api/users/current to the created user
//   2. asserts a row exists in the `sessions` table of data.db
//   3. SIGTERMs the server and starts a fresh process against the SAME DB file
//   4. confirms the SAME cookie still resolves to the SAME user after restart
//      (this is what in-memory storage failed to do)
//
// Run with:  npx tsx script/smoke-session.ts
import { rmSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";

const PORT = 5601;
const DB_PATH = "/tmp/bc-smoke-session.db";
const BASE = `http://127.0.0.1:${PORT}`;

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

function startServer(): ChildProcess {
  return spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
    {
      env: { ...process.env, NODE_ENV: "development", API_ONLY: "1", PORT: String(PORT), DATABASE_PATH: DB_PATH, SMS_PROVIDER: "" },
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

let server = startServer();

async function main() {
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

  // A session row is persisted in the same data.db.
  let sdb = new Database(DB_PATH, { readonly: true });
  const sessRow = sdb.prepare("SELECT sid, sess, expire FROM sessions LIMIT 1").get() as
    | { sid: string; sess: string; expire: string }
    | undefined;
  sdb.close();
  assert(!!sessRow, "a row exists in the sessions table");
  assert(JSON.parse(sessRow!.sess).userId === created.id, "persisted session stores the rider's userId");

  // Restart the server against the same DB file.
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
    await stop(server);
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });

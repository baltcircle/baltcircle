// Smoke test for rider registration persistence.
//
// Boots the real Express server against a throwaway SQLite DB on a test port,
// then:
//   1. confirms /api/users/current is null before registration
//   2. registers a user and checks the response + 201
//   3. confirms the session cookie now resolves to the same user
//   4. reopens the DB file directly and asserts the row was persisted
//
// Run with:  npx tsx script/smoke-register.ts
import { rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const PORT = 5599;
const DB_PATH = "/tmp/bc-smoke-register.db";
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

// Minimal cookie jar: capture set-cookie from register and replay on current.
function cookieFromSetCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

const server = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
  {
    env: { ...process.env, NODE_ENV: "development", PORT: String(PORT), DATABASE_PATH: DB_PATH },
    stdio: ["ignore", "ignore", "inherit"],
  },
);

async function main() {
  await waitForServer();

  // 1. No user yet
  let res = await fetch(`${BASE}/api/users/current`);
  let body = await res.json();
  assert(body === null, "GET /api/users/current is null before registration");

  // 2. Invalid registration is rejected
  res = await fetch(`${BASE}/api/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "A", phone: "123" }),
  });
  assert(res.status === 400, "register rejects too-short name/phone with 400");

  // 3. Valid registration succeeds and sets a session cookie
  res = await fetch(`${BASE}/api/users/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иван Тестов", phone: "8 (900) 123-45-67" }),
  });
  assert(res.status === 201, "register returns 201 for valid input");
  const created = await res.json();
  assert(typeof created.id === "string" && created.id.length > 0, "registered user has an id");
  assert(created.name === "Иван Тестов", "registered name is stored as entered");
  assert(created.phone === "+79001234567", "phone normalized to +7 form");

  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"));
  assert(!!cookie, "register sets a session cookie");

  // 4. Session resolves to the same user
  res = await fetch(`${BASE}/api/users/current`, { headers: { cookie: cookie! } });
  body = await res.json();
  assert(body && body.id === created.id, "session cookie resolves /api/users/current to same user");

  // 5. Row is actually persisted to SQLite
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT id, name, phone, created_at FROM users WHERE id = ?").get(created.id) as
    | { id: string; name: string; phone: string; created_at: number }
    | undefined;
  db.close();
  assert(!!row, "user row exists in SQLite users table");
  assert(row!.phone === "+79001234567", "persisted phone matches normalized value");

  console.log("\nAll registration smoke checks passed.");
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

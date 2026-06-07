// Smoke test for the SMS OTP rider registration flow (dev fallback mode).
//
// Boots the real Express server against a throwaway SQLite DB on a test port
// with NO SMS provider configured, so the backend uses the dev fallback that
// echoes the OTP back to the client instead of sending a real SMS. Then:
//   1. confirms /api/users/current is null before verification
//   2. rejects start without consent / with bad input
//   3. starts OTP, receives the dev code, and checks no user/session yet
//   4. rejects a wrong code, then verifies the correct one -> 201 + session
//   5. confirms the session resolves to the created user
//   6. reopens the DB file directly and asserts the user row was persisted and
//      the OTP code is stored only as a hash (never plaintext)
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

// Minimal cookie jar: capture set-cookie and replay it.
function cookieFromSetCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

const server = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
  {
    // SMS_PROVIDER intentionally unset -> dev fallback echoes the code.
    env: { ...process.env, NODE_ENV: "development", API_ONLY: "1", PORT: String(PORT), DATABASE_PATH: DB_PATH, SMS_PROVIDER: "" },
    stdio: ["ignore", "ignore", "inherit"],
  },
);

async function main() {
  await waitForServer();

  // 1. No user yet
  let res = await fetch(`${BASE}/api/users/current`);
  let body = await res.json();
  assert(body === null, "GET /api/users/current is null before verification");

  // 2a. start without consent is rejected
  res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иван Тестов", phone: "8 (900) 123-45-67", consent: false }),
  });
  assert(res.status === 400, "start rejects missing consent with 400");

  // 2b. start with too-short name is rejected
  res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "A", phone: "89001234567", consent: true }),
  });
  assert(res.status === 400, "start rejects too-short name with 400");

  // 3. Valid start succeeds, echoes dev code, sets no session/user yet
  res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иван Тестов", phone: "8 (900) 123-45-67", consent: true }),
  });
  assert(res.status === 200, "start returns 200 for valid input");
  const startBody = await res.json();
  assert(startBody.phone === "+79001234567", "start normalizes phone to +7 form");
  assert(/^\d{4}$/.test(startBody.devCode ?? ""), "dev fallback echoes a 4-digit code");
  const startCookie = cookieFromSetCookie(res.headers.get("set-cookie"));

  res = await fetch(`${BASE}/api/users/current`, startCookie ? { headers: { cookie: startCookie } } : undefined);
  body = await res.json();
  assert(body === null, "no user session created before verification");

  // 4a. wrong code is rejected
  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+79001234567", code: startBody.devCode === "0000" ? "1111" : "0000" }),
  });
  assert(res.status === 400, "verify rejects a wrong code with 400");

  // 4b. correct code verifies -> 201 + session cookie
  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+79001234567", code: startBody.devCode }),
  });
  assert(res.status === 201, "verify returns 201 for the correct code");
  const created = await res.json();
  assert(typeof created.id === "string" && created.id.length > 0, "verified user has an id");
  assert(created.name === "Иван Тестов", "verified name is stored as entered");
  assert(created.phone === "+79001234567", "phone normalized to +7 form");

  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"));
  assert(!!cookie, "verify sets a session cookie");

  // 5. Session resolves to the same user
  res = await fetch(`${BASE}/api/users/current`, { headers: { cookie: cookie! } });
  body = await res.json();
  assert(body && body.id === created.id, "session cookie resolves /api/users/current to same user");

  // 6. Row persisted; OTP stored only as a hash, never plaintext
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT id, name, phone FROM users WHERE id = ?").get(created.id) as
    | { id: string; name: string; phone: string }
    | undefined;
  const otpRow = db.prepare("SELECT code_hash, consumed FROM otp_requests WHERE phone = ?").get("+79001234567") as
    | { code_hash: string; consumed: number }
    | undefined;
  db.close();
  assert(!!row, "user row exists in SQLite users table");
  assert(row!.phone === "+79001234567", "persisted phone matches normalized value");
  assert(!!otpRow, "otp_requests row exists");
  assert(otpRow!.code_hash.length === 64 && otpRow!.code_hash !== startBody.devCode, "OTP stored as a hash, not plaintext");
  assert(otpRow!.consumed === 1, "OTP request marked consumed after verification");

  console.log("\nAll OTP registration smoke checks passed.");
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

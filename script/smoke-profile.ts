// Smoke test for production user foundation: profile update + role bootstrap.
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) and ADMIN_PHONE_NUMBERS set to the test phone. Then:
//   1. registers via OTP and asserts the verified user gets role "admin"
//      (because its phone is in ADMIN_PHONE_NUMBERS) plus consent metadata
//   2. PATCHes /api/users/me to set name + email and asserts persistence
//   3. rejects an invalid email and a phone-change attempt via the same endpoint
//   4. reopens the DB and asserts the row stored role/consent/email correctly
//
// Run with:  npx tsx script/smoke-profile.ts
import { rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const PORT = 5601;
const DB_PATH = "/tmp/bc-smoke-profile.db";
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
      ADMIN_PHONE_NUMBERS: `8 999 111-22-33, +79005554433`,
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);

async function main() {
  await waitForServer();

  // 1. Register the admin phone via OTP.
  let res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Админ Тестов", phone: "8 999 111-22-33", consent: true }),
  });
  assert(res.status === 200, "OTP start returns 200 for the admin phone");
  const startBody = await res.json();
  assert(startBody.phone === ADMIN_PHONE, "phone normalized to +7 form");

  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: ADMIN_PHONE, code: startBody.devCode }),
  });
  assert(res.status === 201, "verify returns 201");
  const created = await res.json();
  assert(created.role === "admin", "phone in ADMIN_PHONE_NUMBERS gets role=admin");
  assert(typeof created.consentAcceptedAt === "number", "consentAcceptedAt recorded on verify");
  assert(created.consentVersion === "v1-2026-06-07", "consentVersion stored");
  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"))!;
  assert(!!cookie, "verify sets a session cookie");

  // 2. PATCH profile: change name + email.
  res = await fetch(`${BASE}/api/users/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ name: "Админ Обновлённый", email: "admin@baltcircle.app" }),
  });
  assert(res.status === 200, "PATCH /api/users/me returns 200");
  const updated = await res.json();
  assert(updated.name === "Админ Обновлённый", "name persisted");
  assert(updated.email === "admin@baltcircle.app", "email persisted");
  assert(typeof updated.updatedAt === "number", "updatedAt set on profile update");
  assert(updated.phone === ADMIN_PHONE, "phone unchanged by profile update");

  // 3a. Invalid email is rejected.
  res = await fetch(`${BASE}/api/users/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  assert(res.status === 400, "invalid email is rejected with 400");

  // 3b. A phone field in the body is ignored (not accepted by the endpoint).
  res = await fetch(`${BASE}/api/users/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ phone: "+70000000000" }),
  });
  assert(res.status === 200, "extra phone field is ignored, not applied");
  const afterPhone = await res.json();
  assert(afterPhone.phone === ADMIN_PHONE, "phone cannot be changed via profile endpoint");

  // 3c. Unauthenticated PATCH is rejected.
  res = await fetch(`${BASE}/api/users/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "No Session" }),
  });
  assert(res.status === 401, "PATCH without session returns 401");

  // 4. Verify persisted row in SQLite.
  const db = new Database(DB_PATH, { readonly: true });
  const row = db
    .prepare("SELECT name, phone, email, role, consent_version, consent_accepted_at FROM users WHERE phone = ?")
    .get(ADMIN_PHONE) as
    | { name: string; phone: string; email: string | null; role: string; consent_version: string | null; consent_accepted_at: number | null }
    | undefined;
  db.close();
  assert(!!row, "user row exists in SQLite");
  assert(row!.email === "admin@baltcircle.app", "persisted email matches");
  assert(row!.role === "admin", "persisted role is admin");
  assert(row!.consent_version === "v1-2026-06-07", "persisted consent version matches");
  assert(typeof row!.consent_accepted_at === "number", "persisted consent timestamp present");

  console.log("\nAll profile/role smoke checks passed.");
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

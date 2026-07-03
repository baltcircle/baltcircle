// Smoke test for account self-service: phone change (SMS OTP), payment methods,
// and support tickets — all scoped to the logged-in rider.
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) so the OTP flow is testable without a provider. Then:
//   1. registers a rider via OTP and binds a session
//   2. changes the phone via SMS OTP and asserts the new number persists, and
//      that a wrong code is rejected and the profile PATCH still can't touch it
//   3. links a card + SBP payment method, lists them, unlinks one
//   4. files a support ticket and lists it back
//   5. reopens the DB and asserts the phone/payment/support rows persisted, and
//      that no code is stored in plaintext
//
// Run with:  npx tsx script/smoke-account.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown, openTestDb } from "./smoke-pg";

const NAME = "account";
const PORT = 5602;
const BASE = `http://127.0.0.1:${PORT}`;
const OLD_PHONE = "+79990001122";
const NEW_PHONE = "+79993334455";

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

async function main() {
  DB_URL = (await createTestDb(NAME)).url;
  server = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
    {
      env: { ...process.env, NODE_ENV: "development", API_ONLY: "1", PORT: String(PORT), DATABASE_URL: DB_URL, SMS_PROVIDER: "" },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  await waitForServer();

  // 1. Register a rider via OTP.
  let res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Иван Тестов", phone: OLD_PHONE, consent: true }),
  });
  assert(res.status === 200, "OTP start returns 200");
  const startBody = await res.json();

  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: OLD_PHONE, code: startBody.devCode }),
  });
  assert(res.status === 201, "OTP verify returns 201");
  const created = await res.json();
  assert(created.phone === OLD_PHONE, "registered with the old phone");
  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"))!;
  assert(!!cookie, "verify sets a session cookie");

  // 1b. Private rider data must NOT fall back to the shared demo account for an
  // anonymous caller — every wallet/payments/cards/tickets route returns 401
  // without a session (regression guard for the riderId("demo") IDOR fix).
  for (const [method, path] of [
    ["GET", "/api/wallet"],
    ["GET", "/api/payments"],
    ["GET", "/api/payment-methods"],
    ["GET", "/api/support/tickets"],
  ] as const) {
    res = await fetch(`${BASE}${path}`, { method });
    assert(res.status === 401, `${method} ${path} without a session returns 401`);
  }
  res = await fetch(`${BASE}/api/wallet/topup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: 100 }),
  });
  assert(res.status === 401, "POST /api/wallet/topup without a session returns 401");

  // 2a. Phone change requires a session.
  res = await fetch(`${BASE}/api/users/me/phone/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: NEW_PHONE }),
  });
  assert(res.status === 401, "phone change start without session returns 401");

  // 2b. Request a code for the new number.
  res = await fetch(`${BASE}/api/users/me/phone/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ phone: NEW_PHONE }),
  });
  assert(res.status === 200, "phone change start returns 200");
  const pcStart = await res.json();
  assert(pcStart.phone === NEW_PHONE, "phone change targets the new number");
  assert(typeof pcStart.devCode === "string", "dev code echoed for new number");

  // 2c. A wrong code is rejected and the phone is unchanged.
  res = await fetch(`${BASE}/api/users/me/phone/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ code: "0000" === pcStart.devCode ? "1111" : "0000" }),
  });
  assert(res.status === 400, "wrong phone-change code rejected with 400");

  res = await fetch(`${BASE}/api/users/current`, { headers: { cookie } });
  let current = await res.json();
  assert(current.phone === OLD_PHONE, "phone unchanged after a wrong code");

  // 2d. The profile PATCH endpoint still cannot change the phone.
  res = await fetch(`${BASE}/api/users/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ phone: NEW_PHONE }),
  });
  assert(res.status === 200, "profile PATCH with phone returns 200 (ignored)");
  current = await res.json();
  assert(current.phone === OLD_PHONE, "profile PATCH cannot change phone");

  // 2e. Verify the correct code -> phone changes.
  res = await fetch(`${BASE}/api/users/me/phone/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ code: pcStart.devCode }),
  });
  assert(res.status === 200, "phone change verify returns 200");
  const changed = await res.json();
  assert(changed.phone === NEW_PHONE, "phone updated to the new number");

  // 3. Payment methods.
  res = await fetch(`${BASE}/api/payment-methods`, { headers: { cookie } });
  let methods = await res.json();
  assert(Array.isArray(methods) && methods.length === 0, "no payment methods initially");

  res = await fetch(`${BASE}/api/payment-methods`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ type: "card" }),
  });
  assert(res.status === 201, "link card returns 201");
  const card = await res.json();
  assert(card.type === "card" && /4242/.test(card.label), "card linked with masked label");

  res = await fetch(`${BASE}/api/payment-methods`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ type: "sbp" }),
  });
  assert(res.status === 201, "link SBP returns 201");

  res = await fetch(`${BASE}/api/payment-methods`, { headers: { cookie } });
  methods = await res.json();
  assert(methods.length === 2, "two payment methods linked");

  res = await fetch(`${BASE}/api/payment-methods/${card.id}`, { method: "DELETE", headers: { cookie } });
  assert(res.status === 200, "unlink card returns 200");
  res = await fetch(`${BASE}/api/payment-methods`, { headers: { cookie } });
  methods = await res.json();
  assert(methods.length === 1 && methods[0].type === "sbp", "card unlinked, SBP remains");

  // A bad payment type is rejected.
  res = await fetch(`${BASE}/api/payment-methods`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ type: "bitcoin" }),
  });
  assert(res.status === 400, "unknown payment type rejected with 400");

  // 4. Support tickets.
  res = await fetch(`${BASE}/api/support/tickets`, { headers: { cookie } });
  let tickets = await res.json();
  assert(Array.isArray(tickets) && tickets.length === 0, "no support tickets initially");

  res = await fetch(`${BASE}/api/support/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ subject: "Не работает замок", message: "Замок не открывается после оплаты." }),
  });
  assert(res.status === 201, "create support ticket returns 201");

  res = await fetch(`${BASE}/api/support/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ subject: "x", message: "y" }),
  });
  assert(res.status === 400, "too-short support ticket rejected with 400");

  res = await fetch(`${BASE}/api/support/tickets`, { headers: { cookie } });
  tickets = await res.json();
  assert(tickets.length === 1 && tickets[0].subject === "Не работает замок", "support ticket persisted and listed");

  // 5. Inspect the DB directly.
  const db = await openTestDb(DB_URL);
  const userRow = (await db.prepare("SELECT phone FROM users WHERE id = ?").get(created.id)) as { phone: string } | undefined;
  assert(userRow?.phone === NEW_PHONE, "persisted phone is the new number");

  const pcRow = (await db.prepare("SELECT code_hash, consumed FROM phone_change_requests WHERE user_id = ?").get(created.id)) as
    | { code_hash: string; consumed: boolean }
    | undefined;
  assert(!!pcRow && pcRow.consumed === true, "phone-change request consumed");
  assert(!!pcRow && !pcRow.code_hash.includes(pcStart.devCode), "phone-change code stored only as a hash");

  const pmCount = Number(
    ((await db.prepare("SELECT COUNT(*) AS c FROM payment_methods WHERE user_id = ?").get(created.id)) as { c: number | string }).c,
  );
  assert(pmCount === 1, "one payment method row persisted");

  const stRow = (await db.prepare("SELECT subject FROM support_tickets WHERE user_id = ?").get(created.id)) as { subject: string } | undefined;
  assert(stRow?.subject === "Не работает замок", "support ticket persisted in DB");
  await db.close();

  console.log("\nAll account smoke checks passed.");
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

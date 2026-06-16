// Smoke test for the AddCard request payload shape.
//
// Verifies — without any real credentials — that tbankAddCard sends the params
// T-Bank's /AddCard endpoint actually expects:
//   - the AddCard-specific redirect fields SuccessAddCardURL / FailAddCardURL
//     (NOT the generic SuccessURL / FailURL used by Init),
//   - NotificationURL,
//   - CustomerKey and a CheckType,
//   - TerminalKey + a SHA-256 Token injected by signedPost.
// It also checks that TBANK_ADD_CARD_CHECK_TYPE flows through getTbankConfig and
// that parseCheckType normalizes/falls back correctly.
//
// fetch is stubbed so nothing leaves the process; the dummy terminal key and
// password below are obvious non-secrets used only to exercise the signing path.
//
// Run with:  npx tsx script/smoke-tbank-addcard.ts

import { computeToken, parseCheckType, tbankAddCard, type TbankConfig } from "../server/tbank";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

// --- parseCheckType ---
assert(parseCheckType(undefined) === "3DS", "parseCheckType defaults to 3DS when unset");
assert(parseCheckType("") === "3DS", "parseCheckType defaults to 3DS when empty");
assert(parseCheckType("no") === "NO", "parseCheckType uppercases a valid value (no -> NO)");
assert(parseCheckType("3DSHOLD") === "3DSHOLD", "parseCheckType passes through 3DSHOLD");
assert(parseCheckType("bogus") === "3DS", "parseCheckType falls back to 3DS for invalid input");

// --- AddCard payload shape (fetch stubbed) ---
const cfg: TbankConfig = {
  terminalKey: "DummyTerminalKey",
  password: "dummy-password",
  apiBase: "https://example.test/v2",
  publicAppUrl: "https://app.test",
  addCardCheckType: "3DS",
};

let captured: { url: string; body: Record<string, unknown> } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  captured = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
  return {
    ok: true,
    status: 200,
    json: async () => ({ Success: true, PaymentURL: "https://pay.test/x", RequestKey: "rk-1" }),
  } as unknown as Response;
}) as typeof fetch;

try {
  const resp = await tbankAddCard(cfg, { customerKey: "user-123" });
  assert(resp.Success === true, "tbankAddCard returns the parsed Success response");

  const c = captured as { url: string; body: Record<string, unknown> } | null;
  assert(!!c, "AddCard issued an HTTP request");
  const body = c!.body;

  assert(c!.url === "https://example.test/v2/AddCard", "AddCard posts to the /AddCard path");
  assert(body.TerminalKey === "DummyTerminalKey", "payload carries TerminalKey");
  assert(body.CustomerKey === "user-123", "payload carries CustomerKey");
  assert(body.CheckType === "3DS", "payload carries CheckType from config default");

  // The core regression: AddCard-specific redirect field names.
  assert(
    body.SuccessAddCardURL === "https://app.test/payment-methods",
    "payload uses SuccessAddCardURL (not generic SuccessURL)",
  );
  assert(
    body.FailAddCardURL === "https://app.test/payment-methods",
    "payload uses FailAddCardURL (not generic FailURL)",
  );
  assert(!("SuccessURL" in body), "payload does NOT include the generic SuccessURL");
  assert(!("FailURL" in body), "payload does NOT include the generic FailURL");
  assert(
    body.NotificationURL === "https://app.test/api/payments/tbank/notification",
    "payload carries NotificationURL",
  );

  // Token must match a recomputation over the same payload (minus Token).
  const { Token, ...signable } = body as Record<string, unknown> & { Token?: string };
  assert(typeof Token === "string" && Token.length === 64, "payload carries a 64-hex Token");
  assert(
    computeToken(signable, cfg.password) === Token,
    "payload Token matches a recomputed SHA-256 signature",
  );

  // CheckType override is honoured.
  captured = null;
  await tbankAddCard(cfg, { customerKey: "user-9", checkType: "NO" });
  assert((captured as any)!.body.CheckType === "NO", "explicit checkType override is sent");
} finally {
  globalThis.fetch = realFetch;
}

if (!process.exitCode) console.log("\nAll T-Bank AddCard payload smoke checks passed.");

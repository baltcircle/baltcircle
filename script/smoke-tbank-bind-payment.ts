// Smoke test for the Init+Recurrent card-binding payment path.
//
// Verifies — without any real credentials — that:
//   1. parseBindAmount normalizes the verification-payment amount and falls back
//      to the 100-kopeck (1 ₽) default for empty/invalid/zero/negative values.
//   2. tbankInitBindCard posts to /Init with EXACTLY the documented Init fields
//      (Amount, OrderId, Description, CustomerKey, Recurrent=Y, the redirect/
//      notify URLs) plus the injected TerminalKey + SHA-256 Token, and that the
//      Token matches a recomputation over the final payload (the signed set ===
//      the sent set — the classic guard against code 204 "invalid token").
//   3. classifyInitBinding maps the verification-payment lifecycle to our
//      active/failed/pending states (active only with a RebillId on
//      AUTHORIZED/CONFIRMED).
//   4. getTbankConfig returns null when the terminal key/password is missing, so
//      the routes can answer 503 instead of attempting a doomed request.
//
// fetch is stubbed so nothing leaves the process; the dummy terminal key and
// password below are obvious non-secrets used only to exercise the signing path.
//
// Run with:  npx tsx script/smoke-tbank-bind-payment.ts

import {
  computeToken, parseBindAmount, tbankInitBindCard, classifyInitBinding,
  getTbankConfig, type TbankConfig,
} from "../server/tbank";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

// --- parseBindAmount ---
assert(parseBindAmount(undefined) === 100, "parseBindAmount defaults to 100 kopecks when unset");
assert(parseBindAmount("") === 100, "parseBindAmount defaults to 100 when empty");
assert(parseBindAmount("250") === 250, "parseBindAmount parses a valid integer");
assert(parseBindAmount("0") === 100, "parseBindAmount rejects zero -> default");
assert(parseBindAmount("-5") === 100, "parseBindAmount rejects negative -> default");
assert(parseBindAmount("abc") === 100, "parseBindAmount rejects non-numeric -> default");
assert(parseBindAmount("199.9") === 199, "parseBindAmount truncates to whole kopecks");

// --- classifyInitBinding ---
assert(
  classifyInitBinding({ status: "CONFIRMED", rebillId: "r1" }) === "active",
  "CONFIRMED + RebillId -> active",
);
assert(
  classifyInitBinding({ status: "AUTHORIZED", rebillId: "r1" }) === "active",
  "AUTHORIZED + RebillId -> active",
);
assert(
  classifyInitBinding({ status: "CONFIRMED" }) === "pending",
  "CONFIRMED without RebillId -> pending (no recurring token yet)",
);
assert(
  classifyInitBinding({ status: "REJECTED" }) === "failed",
  "REJECTED -> failed",
);
assert(
  classifyInitBinding({ status: "NEW", success: false }) === "failed",
  "Success=false -> failed",
);
assert(
  classifyInitBinding({ status: "FORM_SHOWED" }) === "pending",
  "intermediate status -> pending",
);

// --- getTbankConfig returns null when credentials are absent ---
const savedKey = process.env.TBANK_TERMINAL_KEY;
const savedPw = process.env.TBANK_PASSWORD;
delete process.env.TBANK_TERMINAL_KEY;
delete process.env.TBANK_PASSWORD;
assert(getTbankConfig() === null, "getTbankConfig returns null with no credentials (routes -> 503)");
if (savedKey !== undefined) process.env.TBANK_TERMINAL_KEY = savedKey;
if (savedPw !== undefined) process.env.TBANK_PASSWORD = savedPw;

// --- Init bind-card payload shape (fetch stubbed) ---
const cfg: TbankConfig = {
  terminalKey: "DummyTerminalKey",
  password: "dummy-password",
  apiBase: "https://example.test/v2",
  publicAppUrl: "https://app.test",
  addCardCheckType: "3DS",
  cardBindAmountKopecks: 100,
};

let captured: { url: string; body: Record<string, unknown> } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  captured = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
  return {
    ok: true,
    status: 200,
    json: async () => ({ Success: true, PaymentURL: "https://pay.test/x", PaymentId: "98765" }),
  } as unknown as Response;
}) as typeof fetch;

try {
  const resp = await tbankInitBindCard(cfg, {
    orderId: "bind-user-1-123",
    amountKopecks: 100,
    customerKey: "user-1",
    description: "Проверочный платёж для привязки карты",
    successUrl: "https://app.test/payment-methods",
    failUrl: "https://app.test/payment-methods",
    notificationUrl: "https://app.test/api/payments/tbank/notification",
  });
  assert(resp.Success === true, "tbankInitBindCard returns the parsed Success response");
  assert(resp.PaymentURL === "https://pay.test/x", "tbankInitBindCard surfaces the PaymentURL");

  const c = captured as { url: string; body: Record<string, unknown> } | null;
  assert(!!c, "Init issued an HTTP request");
  const body = c!.body;

  assert(c!.url === "https://example.test/v2/Init", "Init posts to the /Init path");
  assert(body.TerminalKey === "DummyTerminalKey", "payload carries TerminalKey");
  assert(body.Amount === 100, "payload carries Amount in kopecks");
  assert(body.OrderId === "bind-user-1-123", "payload carries OrderId");
  assert(body.CustomerKey === "user-1", "payload carries CustomerKey");
  assert(body.Recurrent === "Y", "payload carries Recurrent=Y (issues a RebillId)");
  assert(body.Description === "Проверочный платёж для привязки карты", "payload carries Description");
  assert(
    body.NotificationURL === "https://app.test/api/payments/tbank/notification",
    "payload carries NotificationURL (a valid Init field)",
  );
  assert(body.SuccessURL === "https://app.test/payment-methods", "payload carries SuccessURL");
  assert(body.FailURL === "https://app.test/payment-methods", "payload carries FailURL");

  // Token must match a recomputation over the EXACT final payload (minus Token).
  const { Token, ...signable } = body as Record<string, unknown> & { Token?: string };
  assert(typeof Token === "string" && Token.length === 64, "payload carries a 64-hex Token");
  assert(
    computeToken(signable, cfg.password) === Token,
    "payload Token matches a recomputed SHA-256 signature over the final Init payload",
  );

  // A password containing '$' must be signed verbatim (delivery, not code, is
  // the only place a leading $ can be lost).
  captured = null;
  const dollarCfg: TbankConfig = { ...cfg, password: "$abc$def" };
  await tbankInitBindCard(dollarCfg, {
    orderId: "bind-user-2-1",
    amountKopecks: 100,
    customerKey: "user-2",
    description: "d",
    successUrl: "https://app.test/payment-methods",
    failUrl: "https://app.test/payment-methods",
    notificationUrl: "https://app.test/api/payments/tbank/notification",
  });
  const dollarBody = (captured as any)!.body as Record<string, unknown>;
  const { Token: dollarToken, ...dollarSignable } = dollarBody as Record<string, unknown> & {
    Token?: string;
  };
  assert(
    computeToken(dollarSignable, "$abc$def") === dollarToken,
    "token is computed with a $-containing password used verbatim",
  );
  assert(
    computeToken(dollarSignable, "abcdef") !== dollarToken,
    "stripping the $ from the password changes the token (delivery must preserve $)",
  );
} finally {
  globalThis.fetch = realFetch;
}

if (!process.exitCode) console.log("\nAll T-Bank bind-payment smoke checks passed.");

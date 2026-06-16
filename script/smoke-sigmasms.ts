// Smoke test for the SigmaSMS OTP transport.
//
// Verifies the request shape (URL, headers, JSON body) and the failure handling
// against a MOCKED fetch — no real token and no network call. Mirrors the
// SigmaSMS "sendings" API contract:
//   POST {base}/sendings
//   Headers: Content-Type: application/json, Authorization: <token>
//   Body:    { recipient, type: "sms", payload: { sender, text } }
//
// Run with:  npx tsx script/smoke-sigmasms.ts

import {
  buildSigmaSmsRequest,
  sendViaSigmaSms,
  sendOtpSms,
  otpMessage,
} from "../server/sms";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

// Obvious non-secret placeholder — never a real token.
const FAKE_TOKEN = "test-token-do-not-use";
const PHONE = "+79991234567";
const CODE = "123456";

// --- 1. Default request shape ---------------------------------------------
delete process.env.SIGMASMS_SENDER;
delete process.env.SIGMASMS_API_BASE;
{
  const req = buildSigmaSmsRequest(PHONE, CODE, FAKE_TOKEN);
  assert(
    req.url === "https://user.sigmasms.ru/api/sendings",
    "default URL is the production /sendings endpoint",
  );
  assert(
    req.headers["Content-Type"] === "application/json",
    "Content-Type header is application/json",
  );
  assert(req.headers.Authorization === FAKE_TOKEN, "Authorization header carries the raw token");
  assert(req.body.recipient === PHONE, "body.recipient is the +7 phone");
  assert(req.body.type === "sms", "body.type is \"sms\"");
  assert(req.body.payload.sender === "TakeRide", "default sender is TakeRide");
  assert(req.body.payload.text === otpMessage(CODE), "body.payload.text is the OTP message");
}

// --- 2. Sender + API base overrides + trailing-slash trimming -------------
process.env.SIGMASMS_SENDER = "MyBrand";
process.env.SIGMASMS_API_BASE = "https://custom.example/api/";
{
  const req = buildSigmaSmsRequest(PHONE, CODE, FAKE_TOKEN);
  assert(req.body.payload.sender === "MyBrand", "SIGMASMS_SENDER overrides the sender");
  assert(
    req.url === "https://custom.example/api/sendings",
    "SIGMASMS_API_BASE overrides the base and trailing slash is trimmed",
  );
}
delete process.env.SIGMASMS_SENDER;
delete process.env.SIGMASMS_API_BASE;

// --- 3. Successful send via a mocked fetch --------------------------------
process.env.SIGMASMS = FAKE_TOKEN;
{
  let captured: { url: string; init: any } | undefined;
  const mockFetch = async (url: string, init: any) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "abc-123", recipient: PHONE, status: "queued" }),
    };
  };
  await sendViaSigmaSms(PHONE, CODE, mockFetch as any);
  assert(captured!.init.method === "POST", "send uses HTTP POST");
  assert(captured!.url === "https://user.sigmasms.ru/api/sendings", "send hits the /sendings URL");
  const sentBody = JSON.parse(captured!.init.body);
  assert(sentBody.recipient === PHONE && sentBody.type === "sms", "sent body matches the contract");
  assert(
    captured!.init.headers.Authorization === FAKE_TOKEN,
    "sent Authorization header carries the token",
  );
  console.log("✓ successful send resolves without throwing");
}

// --- 4. Provider error in the JSON body is treated as failure -------------
{
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ error: "insufficient funds" }),
  });
  let threw = false;
  try {
    await sendViaSigmaSms(PHONE, CODE, mockFetch as any);
  } catch (e: any) {
    threw = true;
    assert(
      !/insufficient funds/i.test(e.message),
      "user-facing error does not leak the provider error text",
    );
  }
  assert(threw, "an error field in the response throws a user-friendly error");
}

// --- 5. Non-2xx HTTP status is treated as failure -------------------------
{
  const mockFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  let threw = false;
  try {
    await sendViaSigmaSms(PHONE, CODE, mockFetch as any);
  } catch {
    threw = true;
  }
  assert(threw, "a non-2xx HTTP status throws");
}

// --- 6. Missing token => config error when SMS_PROVIDER=sigmasms ----------
{
  delete process.env.SIGMASMS;
  delete process.env.SIGMASMS_TOKEN;
  process.env.SMS_PROVIDER = "sigmasms";
  let threw = false;
  try {
    await sendOtpSms(PHONE, CODE);
  } catch (e: any) {
    threw = true;
    assert(typeof e.message === "string" && e.message.length > 0, "missing-token error has a message");
  }
  assert(threw, "sendOtpSms throws a config error when sigmasms is selected but no token is set");
}

// --- 7. SIGMASMS_TOKEN takes precedence over SIGMASMS ---------------------
{
  process.env.SIGMASMS = "from-sigmasms";
  process.env.SIGMASMS_TOKEN = "from-sigmasms-token";
  const req = buildSigmaSmsRequest(PHONE, CODE, process.env.SIGMASMS_TOKEN || process.env.SIGMASMS || "");
  assert(req.headers.Authorization === "from-sigmasms-token", "SIGMASMS_TOKEN wins over SIGMASMS");
  delete process.env.SIGMASMS;
  delete process.env.SIGMASMS_TOKEN;
}
delete process.env.SMS_PROVIDER;

if (!process.exitCode) console.log("\nAll SigmaSMS smoke checks passed.");

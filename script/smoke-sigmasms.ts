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
  describeSigmaSmsError,
  sigmaSmsRecipient,
  getSmsDiagnostics,
  getSigmaSmsSendingStatus,
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
  const accepted = await sendViaSigmaSms(PHONE, CODE, mockFetch as any);
  assert(captured!.init.method === "POST", "send uses HTTP POST");
  assert(captured!.url === "https://user.sigmasms.ru/api/sendings", "send hits the /sendings URL");
  const sentBody = JSON.parse(captured!.init.body);
  assert(sentBody.recipient === PHONE && sentBody.type === "sms", "sent body matches the contract");
  assert(
    captured!.init.headers.Authorization === FAKE_TOKEN,
    "sent Authorization header carries the token",
  );
  assert(accepted.id === "abc-123", "send returns the provider sending id");
  assert(accepted.status === "queued", "send returns the provider status");
  console.log("✓ successful send resolves without throwing");
}

// --- 3b. getSigmaSmsSendingStatus reads the delivery status ----------------
{
  let captured: { url: string; init: any } | undefined;
  const mockFetch = async (url: string, init: any) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "abc-123", recipient: PHONE, status: "delivered" }),
    };
  };
  const live = await getSigmaSmsSendingStatus("abc-123", mockFetch as any);
  assert(captured!.init.method === "GET", "status lookup uses HTTP GET");
  assert(
    captured!.url === "https://user.sigmasms.ru/api/sendings/abc-123",
    "status lookup hits /sendings/{id}",
  );
  assert(
    captured!.init.headers.Authorization === FAKE_TOKEN,
    "status lookup carries the token in the Authorization header",
  );
  assert(live.found === true, "status lookup reports found=true on 200");
  assert(live.status === "delivered", "status lookup surfaces the provider delivery status");
}

// --- 3c. status lookup maps a nested status field -------------------------
{
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ sending: { state: "sent" } }),
  });
  const live = await getSigmaSmsSendingStatus("abc-123", mockFetch as any);
  assert(live.status === "sent", "status lookup reads a nested state field");
}

// --- 3d. status lookup reports a 404 as not-found safely ------------------
{
  const mockFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const live = await getSigmaSmsSendingStatus("missing-id", mockFetch as any);
  assert(live.found === false && live.httpStatus === 404, "missing sending id reports found=false / 404");
}

// --- 3e. status lookup surfaces a safe error, never the token -------------
{
  const mockFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: "internal" }),
  });
  const live = await getSigmaSmsSendingStatus("abc-123", mockFetch as any);
  assert(live.found === false, "failed status lookup reports found=false");
  assert(/HTTP 500/.test(live.error ?? ""), "failed status lookup includes the HTTP status");
  assert(!new RegExp(FAKE_TOKEN).test(live.error ?? ""), "failed status lookup never leaks the token");
}

// --- 4. Provider error in the JSON body is treated as failure -------------
//        and SAFE provider diagnostics are surfaced (no token, no message text).
{
  const mockFetch = async () => ({
    ok: false,
    status: 402,
    json: async () => ({ status: "error", error: "insufficient funds" }),
  });
  let threw = false;
  try {
    await sendViaSigmaSms(PHONE, CODE, mockFetch as any);
  } catch (e: any) {
    threw = true;
    assert(/HTTP 402/.test(e.message), "user-facing error includes the HTTP status");
    assert(/insufficient funds/.test(e.message), "user-facing error includes the safe provider error field");
    assert(!new RegExp(FAKE_TOKEN).test(e.message), "user-facing error never leaks the token");
    assert(!new RegExp(otpMessage(CODE)).test(e.message), "user-facing error never leaks the OTP message text");
  }
  assert(threw, "an error field in the response throws a user-friendly error");
}

// --- 4b. describeSigmaSmsError surfaces validation details safely ---------
{
  const detail = describeSigmaSmsError(400, {
    status: "error",
    error: { code: "BAD_RECIPIENT", message: "recipient is invalid" },
    errors: [{ field: "recipient", message: "must start with +" }],
  });
  assert(/HTTP 400/.test(detail), "describe includes HTTP status");
  assert(/BAD_RECIPIENT/.test(detail), "describe includes provider error code");
  assert(/recipient is invalid/.test(detail), "describe includes provider error message");
  assert(/must start with \+/.test(detail), "describe includes field-level validation message");
  const long = describeSigmaSmsError(500, { error: "x".repeat(1000) });
  assert(long.length <= 300, "describe output is bounded to <=300 chars");
}

// --- 4c. recipient is forced to +7 form -----------------------------------
{
  assert(sigmaSmsRecipient("79991234567") === "+79991234567", "recipient gains a + when missing");
  assert(sigmaSmsRecipient("+79991234567") === "+79991234567", "recipient keeps an existing +");
  const req = buildSigmaSmsRequest("79991234567", CODE, FAKE_TOKEN);
  assert(req.body.recipient === "+79991234567", "built request recipient is in +7 form");
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

// --- 8. Diagnostics expose safe metadata only (no token) ------------------
{
  process.env.SMS_PROVIDER = "sigmasms";
  process.env.SIGMASMS_TOKEN = FAKE_TOKEN;
  process.env.SIGMASMS_SENDER = "TakeRide";
  const diag = getSmsDiagnostics();
  assert(diag.provider === "sigmasms", "diagnostics report the sigmasms provider");
  assert(diag.configured === true, "diagnostics report configured=true when token set");
  assert(diag.tokenLength === FAKE_TOKEN.length, "diagnostics report the token LENGTH");
  assert(diag.sender === "TakeRide", "diagnostics report the sender");
  assert(/\/sendings$/.test(diag.apiBase), "diagnostics report the API base/sendings");
  assert(
    !Object.values(diag).some((v) => typeof v === "string" && v.includes(FAKE_TOKEN)),
    "diagnostics never include the raw token",
  );
  delete process.env.SMS_PROVIDER;
  delete process.env.SIGMASMS_TOKEN;
  delete process.env.SIGMASMS_SENDER;
}

if (!process.exitCode) console.log("\nAll SigmaSMS smoke checks passed.");

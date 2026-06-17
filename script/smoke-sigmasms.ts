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
  describeFetchException,
  describeNonJsonBody,
  sigmaSmsText,
  sigmaSmsRecipient,
  sigmaSmsApiBase,
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
  // TEMPORARY (SigmaSMS moderation test): SigmaSMS sends the fixed moderation
  // test text, not the OTP message. The real OTP is still generated server-side.
  assert(
    req.body.payload.text === sigmaSmsText(CODE),
    "body.payload.text is the SigmaSMS moderation test message",
  );
  assert(
    req.body.payload.text !== otpMessage(CODE),
    "SigmaSMS text is overridden, not the real OTP message",
  );
}

// --- 1b. SigmaSMS message override (temporary moderation test) -------------
{
  delete process.env.SIGMASMS_MESSAGE_TEMPLATE;
  assert(
    sigmaSmsText(CODE) ===
      "Это тестовое сообщение.\nИзменённый текст будет отправлен на модерацию.",
    "default SigmaSMS text is the moderation test message with a newline",
  );
  assert(!sigmaSmsText(CODE).includes(CODE), "default SigmaSMS text does not contain the OTP code");
  process.env.SIGMASMS_MESSAGE_TEMPLATE = "custom moderation text";
  assert(
    sigmaSmsText(CODE) === "custom moderation text",
    "SIGMASMS_MESSAGE_TEMPLATE overrides the SigmaSMS text",
  );
  delete process.env.SIGMASMS_MESSAGE_TEMPLATE;
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
    !("body" in captured!.init),
    "status lookup GET omits the request body (fetch forbids a body on GET)",
  );
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

// --- 3f. status URL is built from the configured API base (no double /api) -
{
  delete process.env.SIGMASMS_API_BASE;
  assert(
    sigmaSmsApiBase() === "https://user.sigmasms.ru/api",
    "default API base is .../api (single /api segment)",
  );
  let capturedUrl = "";
  const mockFetch = async (url: string) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ status: "delivered" }) };
  };
  await getSigmaSmsSendingStatus("00000000-0008-4548-aa37-635189165383", mockFetch as any);
  assert(
    capturedUrl === "https://user.sigmasms.ru/api/sendings/00000000-0008-4548-aa37-635189165383",
    "status URL is {base}/sendings/{id} with the id percent-encoded, no doubled /api",
  );
}

// --- 3g. a fetch exception is surfaced as a SAFE bounded diagnostic --------
//         (httpStatus 0 = no HTTP response) instead of a generic message.
{
  const cause: any = new Error("getaddrinfo ENOTFOUND user.sigmasms.ru");
  cause.code = "ENOTFOUND";
  const netErr: any = new TypeError("fetch failed");
  netErr.cause = cause;
  const mockFetch = async () => {
    throw netErr;
  };
  const live = await getSigmaSmsSendingStatus("abc-123", mockFetch as any);
  assert(live.found === false, "fetch exception reports found=false");
  assert(live.httpStatus === 0, "fetch exception keeps httpStatus 0 (no HTTP response)");
  assert(/ENOTFOUND/.test(live.error ?? ""), "fetch exception surfaces the underlying network code");
  assert(/fetch failed/.test(live.error ?? ""), "fetch exception surfaces the exception message");
  assert(
    !new RegExp(FAKE_TOKEN).test(live.error ?? ""),
    "fetch exception diagnostic never leaks the token",
  );
}

// --- 3h. describeFetchException bounds output and names the error ----------
{
  const d1 = describeFetchException(new TypeError("boom"));
  assert(/TypeError/.test(d1) && /boom/.test(d1), "describeFetchException includes name + message");
  const big: any = new Error("x".repeat(500));
  assert(describeFetchException(big).length <= 200, "describeFetchException is bounded to <=200 chars");
  assert(
    describeFetchException("plain string") === "plain string",
    "describeFetchException handles non-Error throws",
  );
}

// --- 3i. a non-JSON (HTML) body on the status lookup is surfaced safely -----
{
  const html = "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>";
  const mockFetch = async () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
    text: async () => html,
  });
  const live = await getSigmaSmsSendingStatus("abc-123", mockFetch as any);
  assert(live.found === false && live.httpStatus === 502, "HTML error body reports the HTTP status");
  assert(/502 Bad Gateway/.test(live.error ?? ""), "HTML error body snippet is surfaced");
  assert(/не в формате JSON/.test(live.error ?? ""), "non-JSON body is flagged as such");
}

// --- 3j. a 2xx non-JSON body still reports found with a snippet ------------
{
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
    text: async () => "OK (plain text)",
  });
  const live = await getSigmaSmsSendingStatus("abc-123", mockFetch as any);
  assert(live.found === true && live.httpStatus === 200, "2xx non-JSON reports found=true");
  assert(/OK \(plain text\)/.test(live.error ?? ""), "2xx non-JSON surfaces a body snippet");
  assert(live.status === undefined, "2xx non-JSON has no parsable status");
}

// --- 3k. describeNonJsonBody collapses whitespace and bounds output --------
{
  assert(/пустой ответ/.test(describeNonJsonBody(204, "   ")), "empty body is described as empty");
  const long = describeNonJsonBody(500, "a\n".repeat(500));
  assert(/…$/.test(long) && long.length <= 260, "describeNonJsonBody snippet is bounded");
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

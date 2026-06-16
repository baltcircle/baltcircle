// Smoke test for the client-side error formatter used by the registration and
// phone-change modals. Reproduces the bug we fixed: the API returns
// `{"error":"…"}` and apiRequest throws `Error("502: {\"error\":\"…\"}")`; the
// UI must render the message string, NOT the raw JSON object text.
//
// Run with:  npx tsx script/smoke-error-message.ts

import { errorMessage } from "../client/src/lib/error-message";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

const FALLBACK = "Не удалось отправить код";

// 1. The reported bug: JSON error body must be unwrapped to its string.
{
  const err = new Error('502: {"error":"Не удалось отправить SMS. Попробуйте позже."}');
  const out = errorMessage(err, FALLBACK);
  assert(out === "Не удалось отправить SMS. Попробуйте позже.", "unwraps {\"error\":…} JSON body");
  assert(!out.includes("{"), "result contains no raw JSON braces");
}

// 2. Safe SigmaSMS diagnostics flow through verbatim.
{
  const err = new Error('502: {"error":"Не удалось отправить SMS (HTTP 402, статус: error). Попробуйте позже."}');
  const out = errorMessage(err, FALLBACK);
  assert(/HTTP 402/.test(out), "diagnostic detail is preserved for the user");
  assert(!out.startsWith("502"), "status prefix is stripped");
}

// 3. `message` field is also honoured.
{
  const out = errorMessage(new Error('400: {"message":"Проверьте номер"}'), FALLBACK);
  assert(out === "Проверьте номер", "honours a message field");
}

// 4. Plain-text bodies pass through (minus the status prefix).
{
  const out = errorMessage(new Error("503: Service Unavailable"), FALLBACK);
  assert(out === "Service Unavailable", "plain text body passes through without prefix");
}

// 5. Malformed JSON and empty bodies fall back.
{
  assert(errorMessage(new Error("500: {not json"), FALLBACK) === FALLBACK, "malformed JSON falls back");
  assert(errorMessage(new Error("500: "), FALLBACK) === FALLBACK, "empty body falls back");
  assert(errorMessage(undefined, FALLBACK) === FALLBACK, "undefined error falls back");
}

if (!process.exitCode) console.log("\nAll error-message smoke checks passed.");

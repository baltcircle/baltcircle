// SMS delivery for OTP verification.
//
// Provider is selected by SMS_PROVIDER. Two real providers are wired up:
//   - SMS.RU       (SMS_PROVIDER=smsru,    key in SMSRU_API_ID)
//   - SigmaSMS     (SMS_PROVIDER=sigmasms, token in SIGMASMS / SIGMASMS_TOKEN)
// When no provider is configured we fall back to a dev mode that logs the code
// instead of sending it — this keeps local development and CI smoke tests
// working without a key and without spending SMS quota. Production MUST set
// SMS_PROVIDER to a real provider.

// Local logger. We intentionally do NOT import the logger from ./index, because
// importing index boots the HTTP server (top-level listen). Keeping logging
// self-contained here lets the send logic be unit-tested in isolation.
function log(message: string, source = "sms"): void {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${time} [${source}] ${message}`);
}

export interface SmsSendResult {
  // Whether the OTP should be echoed back to the client. Only true in dev
  // fallback, where there is no real SMS channel — never in production.
  devEcho: boolean;
  // Provider delivery diagnostics for the accepted send, when the provider
  // returns them. Persisted on the OTP request so staff can later query the
  // provider's delivery status. None of these are secret.
  provider?: string;            // "sigmasms" | "smsru"
  providerMessageId?: string;   // provider's sending id, if returned
  providerStatus?: string;      // provider's accepted status text, if returned
}

export function smsProvider(): string {
  return (process.env.SMS_PROVIDER || "").trim().toLowerCase();
}

export function isDevSmsFallback(): boolean {
  // Dev fallback only when no real provider is selected. If SMS_PROVIDER is set
  // (e.g. "smsru") we always attempt the real send and surface failures.
  return smsProvider() === "";
}

export function otpMessage(code: string): string {
  return `TakeRide: код подтверждения ${code}. Никому не сообщайте код.`;
}

// Sends the OTP SMS. Throws a user-friendly (Russian) Error on failure so the
// route can return it directly. Returns whether the code may be echoed to the
// client (dev fallback only).
export async function sendOtpSms(phone: string, code: string): Promise<SmsSendResult> {
  const provider = smsProvider();

  if (provider === "smsru") {
    await sendViaSmsRu(phone, code);
    return { devEcho: false, provider };
  }

  if (provider === "sigmasms") {
    const accepted = await sendViaSigmaSms(phone, code);
    return {
      devEcho: false,
      provider,
      providerMessageId: accepted.id,
      providerStatus: accepted.status,
    };
  }

  if (provider === "" ) {
    // Dev / local fallback: no provider configured. Log the code so a developer
    // can complete the flow; the route echoes it to the client as well.
    log(`[sms:dev] OTP for ${phone}: ${code}`, "sms");
    return { devEcho: true };
  }

  // An unknown provider was configured — fail loudly rather than silently
  // dropping the SMS.
  throw new Error("SMS-провайдер не настроен. Обратитесь в поддержку.");
}

// SMS.RU JSON API: https://sms.ru/api/send
// We use the `json=1` endpoint so we can parse a structured status. The API id
// is the account key from SMSRU_API_ID (never logged).
async function sendViaSmsRu(phone: string, code: string): Promise<void> {
  const apiId = (process.env.SMSRU_API_ID || "").trim();
  if (!apiId) {
    throw new Error("SMS-сервис временно недоступен. Попробуйте позже.");
  }

  const params = new URLSearchParams({
    api_id: apiId,
    to: phone,
    msg: otpMessage(code),
    json: "1",
  });

  let data: any;
  try {
    const res = await fetch("https://sms.ru/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    data = await res.json();
  } catch {
    throw new Error("Не удалось отправить SMS. Проверьте соединение и попробуйте позже.");
  }

  // Top-level status: "OK" means the request was accepted. Per-recipient status
  // lives under sms[phone].status_code (100 = queued/accepted).
  if (data?.status !== "OK") {
    log(`[sms:smsru] request rejected: ${data?.status_code ?? "?"} ${data?.status_text ?? ""}`, "sms");
    throw new Error(smsRuError(Number(data?.status_code)));
  }

  const recipient = data?.sms?.[phone];
  if (recipient && recipient.status !== "OK") {
    log(`[sms:smsru] recipient rejected: ${recipient.status_code} ${recipient.status_text ?? ""}`, "sms");
    throw new Error(smsRuError(Number(recipient.status_code)));
  }
}

// Map a handful of common SMS.RU error codes to friendly Russian messages.
// Anything unmapped gets a generic retry message so we never leak provider
// internals to the rider.
function smsRuError(code: number): string {
  switch (code) {
    case 200: // wrong api_id
    case 201: // not enough funds
      return "SMS-сервис временно недоступен. Попробуйте позже.";
    case 202: // wrong recipient
      return "Не удалось отправить SMS на этот номер. Проверьте номер телефона.";
    case 203: // no message text
    case 204: // sender not approved
    case 207: // can't send to this number
      return "Не удалось отправить SMS на этот номер.";
    case 230: // daily limit per number
    case 231: // same message to same number limit
      return "Слишком много SMS на этот номер. Попробуйте позже.";
    default:
      return "Не удалось отправить SMS. Попробуйте позже.";
  }
}

// --- SigmaSMS ------------------------------------------------------------
// Simple "sendings" REST API: POST {base}/sendings with the static account
// token in the Authorization header and a JSON body describing one SMS.
// Docs: POST https://user.sigmasms.ru/api/sendings
//   Headers: Content-Type: application/json, Authorization: <token>
//   Body:    { recipient, type: "sms", payload: { sender, text } }
//   Response: { id, recipient, status, error }
// Our backend still owns the OTP lifecycle (generate/HMAC/verify); SigmaSMS is
// only the transport for the message text.

const SIGMASMS_DEFAULT_API_BASE = "https://user.sigmasms.ru/api";
const SIGMASMS_DEFAULT_SENDER = "TakeRide";

// Message text for SigmaSMS. Uses otpMessage() by default (same text as SMS.RU);
// can be overridden with SIGMASMS_MESSAGE_TEMPLATE env var (use {code} as placeholder).
export function sigmaSmsText(code: string): string {
  const template = (process.env.SIGMASMS_MESSAGE_TEMPLATE || "").trim();
  if (template) {
    return template.replace("{code}", code);
  }
  return otpMessage(code);
}

// Read the SigmaSMS token. Supports both SIGMASMS (the GitHub secret name) and
// the more explicit SIGMASMS_TOKEN. Returns "" when neither is set.
export function sigmaSmsToken(): string {
  return (process.env.SIGMASMS_TOKEN || process.env.SIGMASMS || "").trim();
}

export function sigmaSmsSender(): string {
  return (process.env.SIGMASMS_SENDER || "").trim() || SIGMASMS_DEFAULT_SENDER;
}

export function sigmaSmsApiBase(): string {
  const base = (process.env.SIGMASMS_API_BASE || "").trim() || SIGMASMS_DEFAULT_API_BASE;
  // Drop a trailing slash so we can join the path cleanly.
  return base.replace(/\/+$/, "");
}

// SigmaSMS expects the recipient in international E.164 form with a leading "+"
// (docs example: +79999999999). Our phone normalization keeps the "+" only when
// the user typed one, so a number entered as "79991234567" reaches us without it
// and SigmaSMS rejects it. Re-add the "+" for the recipient field only — we do
// not mutate the stored/canonical phone.
export function sigmaSmsRecipient(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  return digits ? "+" + digits : trimmed;
}

export interface SigmaSmsRequest {
  url: string;
  headers: Record<string, string>;
  body: { recipient: string; type: "sms"; payload: { sender: string; text: string } };
}

// Build the SigmaSMS request shape (URL, headers, JSON body) without sending it.
// Exposed so a smoke test can assert the request shape with a mocked fetch and
// no real token. The token is included in the Authorization header here; callers
// must never log the returned object verbatim.
export function buildSigmaSmsRequest(
  phone: string,
  code: string,
  token: string,
): SigmaSmsRequest {
  return {
    url: `${sigmaSmsApiBase()}/sendings`,
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: {
      recipient: sigmaSmsRecipient(phone),
      type: "sms",
      payload: { sender: sigmaSmsSender(), text: sigmaSmsText(code) },
    },
  };
}

// Extract a short, SAFE description of a SigmaSMS failure from its response.
// Includes only non-sensitive provider diagnostics — the HTTP status, the
// provider's status/error fields and any validation messages. Never includes the
// token, request headers, sender or message text. Returned string is bounded so
// a verbose provider body can't bloat the API response.
export function describeSigmaSmsError(httpStatus: number, data: any): string {
  const parts: string[] = [`HTTP ${httpStatus}`];

  const status = data?.status;
  if (typeof status === "string" && status.trim()) parts.push(`статус: ${status.trim()}`);

  // The error field may be a string or a {code,message} object.
  const err = data?.error;
  if (typeof err === "string" && err.trim()) {
    parts.push(`ошибка: ${err.trim()}`);
  } else if (err && typeof err === "object") {
    const code = err.code ?? err.status;
    const message = err.message ?? err.text ?? err.description;
    if (code !== undefined) parts.push(`код: ${code}`);
    if (typeof message === "string" && message.trim()) parts.push(`ошибка: ${message.trim()}`);
  }

  // Validation errors: SigmaSMS / similar APIs return field-level messages under
  // `errors` (array of strings or {field,message}) or `description`.
  const validation = collectValidationMessages(data);
  if (validation.length) parts.push(`детали: ${validation.join("; ")}`);
  else if (typeof data?.description === "string" && data.description.trim()) {
    parts.push(`детали: ${data.description.trim()}`);
  }

  const detail = parts.join(", ");
  return detail.length > 300 ? detail.slice(0, 297) + "…" : detail;
}

function collectValidationMessages(data: any): string[] {
  const errors = data?.errors;
  if (!Array.isArray(errors)) return [];
  const out: string[] = [];
  for (const e of errors) {
    if (typeof e === "string" && e.trim()) out.push(e.trim());
    else if (e && typeof e === "object") {
      const field = e.field ?? e.param ?? e.name;
      const message = e.message ?? e.text ?? e.description;
      if (typeof message === "string" && message.trim()) {
        out.push(field ? `${field}: ${message.trim()}` : message.trim());
      }
    }
  }
  return out;
}

// fetch-compatible signature so a smoke test can inject a mock. `body` is
// optional: a GET status lookup must omit it entirely, since the WHATWG fetch
// spec forbids a body on GET/HEAD ("Request with GET/HEAD method cannot have
// body.").
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

// On success returns the provider's sending id and status (both may be absent
// if the provider omits them). These are non-secret and are persisted so the
// delivery status can be queried later via getSigmaSmsSendingStatus.
export interface SigmaSmsAccepted {
  id?: string;
  status?: string;
}

export async function sendViaSigmaSms(
  phone: string,
  code: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SigmaSmsAccepted> {
  const token = sigmaSmsToken();
  if (!token) {
    throw new Error("SMS-сервис временно недоступен. Попробуйте позже.");
  }

  const req = buildSigmaSmsRequest(phone, code, token);

  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
  } catch {
    throw new Error("Не удалось отправить SMS. Проверьте соединение и попробуйте позже.");
  }

  let data: any = undefined;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. an HTML error page). Fall through to the status check.
  }

  // A non-2xx HTTP status, an explicit error field, or a failed status all mean
  // the message was not accepted. We surface SAFE provider diagnostics (HTTP
  // status, provider status/error/validation) so staff can act on the failure —
  // never the token, headers, sender or message text. Logs carry the same safe
  // summary.
  if (!res.ok || data?.error || isSigmaSmsFailedStatus(data?.status)) {
    const detail = describeSigmaSmsError(res.status, data);
    log(`[sms:sigmasms] request rejected: ${detail}`, "sms");
    throw new Error(`Не удалось отправить SMS (${detail}). Попробуйте позже.`);
  }

  const id = typeof data?.id === "string" ? data.id : undefined;
  const status = typeof data?.status === "string" ? data.status.trim() || undefined : undefined;
  return { id, status };
}

// --- SigmaSMS delivery status --------------------------------------------
// Look up the delivery status of a previously accepted sending by its id.
// Docs: GET {base}/sendings/{id} with the account token in the Authorization
// header returns the sending's status/details. We map the response to a SAFE,
// non-secret view: the HTTP status, the provider status text and a bounded
// error summary. The token is sent in the header but never logged or returned.
export interface SigmaSmsStatus {
  found: boolean;       // false when the provider has no record (404)
  httpStatus: number;   // HTTP status of the status lookup
  status?: string;      // provider's delivery status text, if present
  error?: string;       // safe error summary, if the lookup failed
}

export async function getSigmaSmsSendingStatus(
  id: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SigmaSmsStatus> {
  const token = sigmaSmsToken();
  if (!token) {
    throw new Error("SMS-сервис временно недоступен. Попробуйте позже.");
  }

  const url = `${sigmaSmsApiBase()}/sendings/${encodeURIComponent(id)}`;

  let res: { ok: boolean; status: number; json: () => Promise<any>; text?: () => Promise<string> };
  try {
    // GET must NOT carry a body: the fetch spec rejects a body on GET/HEAD with
    // "Request with GET/HEAD method cannot have body." Only the method and the
    // Authorization/Accept headers are sent.
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: token },
    });
  } catch (err) {
    // fetch threw before any HTTP response: DNS failure, TLS error, connection
    // refused/reset, timeout, aborted request, etc. The previous code discarded
    // this and surfaced a generic message with httpStatus 0, which made the
    // failure mode impossible to diagnose. Surface a SAFE, bounded description of
    // the exception (its name + message) so staff can tell a network/DNS/TLS
    // failure apart from an HTTP error. httpStatus stays 0 to denote "no HTTP
    // response". The token is never part of the exception, so this is safe.
    const detail = describeFetchException(err);
    log(`[sms:sigmasms] status lookup fetch failed: ${detail}`, "sms");
    return { found: false, httpStatus: 0, error: `Сетевая ошибка: ${detail}` };
  }

  // Read the body once as text so we can both parse JSON and, on a non-JSON
  // response (HTML error page, plain text), surface a bounded snippet of it.
  const raw = await readBodySafely(res);
  const data = parseJsonSafely(raw);

  if (res.status === 404) {
    return { found: false, httpStatus: 404 };
  }
  if (!res.ok || data?.error || isSigmaSmsFailedStatus(data?.status)) {
    const detail = data
      ? describeSigmaSmsError(res.status, data)
      : describeNonJsonBody(res.status, raw);
    log(`[sms:sigmasms] status lookup failed: ${detail}`, "sms");
    return { found: false, httpStatus: res.status, error: detail };
  }

  // 2xx but the body was non-JSON (or empty): we have no parsable status. Report
  // a safe snippet rather than silently claiming success with no status.
  if (data === undefined) {
    return {
      found: true,
      httpStatus: res.status,
      error: describeNonJsonBody(res.status, raw),
    };
  }

  const status = extractSigmaSmsStatus(data);
  return { found: true, httpStatus: res.status, status };
}

// Describe a fetch exception with only its name and message, bounded in length.
// fetch/undici nests the useful detail under `cause` (e.g. an ENOTFOUND /
// ECONNREFUSED / certificate error), so include that too. Never includes the
// token (it is not part of any fetch exception) or the request URL.
export function describeFetchException(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    if (err.name && err.name !== "Error") parts.push(err.name);
    if (err.message) parts.push(err.message);
    const cause: any = (err as any).cause;
    if (cause) {
      const causeName = typeof cause?.name === "string" ? cause.name : undefined;
      const causeCode = typeof cause?.code === "string" ? cause.code : undefined;
      const causeMsg = typeof cause?.message === "string" ? cause.message : undefined;
      const causeDetail = [causeCode, causeName, causeMsg].filter(Boolean).join(" ");
      if (causeDetail) parts.push(`(${causeDetail})`);
    }
  } else if (typeof err === "string" && err.trim()) {
    parts.push(err.trim());
  }
  const detail = parts.join(": ") || "неизвестная ошибка сети";
  return detail.length > 200 ? detail.slice(0, 197) + "…" : detail;
}

// Read a response body as text without throwing. Returns "" when the body can't
// be read or the response exposes no text()/json() reader (e.g. a minimal mock).
async function readBodySafely(res: {
  json: () => Promise<any>;
  text?: () => Promise<string>;
}): Promise<string> {
  if (typeof res.text === "function") {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }
  // Fallback for mocks that only implement json(): re-serialize the parsed JSON
  // so readBodySafely + parseJsonSafely still round-trips in tests.
  try {
    const parsed = await res.json();
    return parsed === undefined ? "" : JSON.stringify(parsed);
  } catch {
    return "";
  }
}

// Parse text as JSON, returning undefined (not throwing) for empty/non-JSON
// bodies such as an HTML error page.
function parseJsonSafely(raw: string): any {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

// Build a SAFE, bounded description for a non-JSON response body. Collapses
// whitespace and includes a short snippet so staff can tell an HTML/login/error
// page apart from an empty body. The body of a status lookup never contains the
// token or message text, so a snippet is safe to surface.
export function describeNonJsonBody(httpStatus: number, raw: string): string {
  const snippet = raw.replace(/\s+/g, " ").trim();
  if (!snippet) return `HTTP ${httpStatus}, пустой ответ (не JSON)`;
  const bounded = snippet.length > 200 ? snippet.slice(0, 197) + "…" : snippet;
  return `HTTP ${httpStatus}, ответ не в формате JSON: ${bounded}`;
}

// Pull the delivery status text from a status-lookup response. SigmaSMS may
// place it at the top level or nest it (e.g. under `state`/`sending`). Returns
// undefined when no recognisable status string is present.
function extractSigmaSmsStatus(data: any): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const candidates = [data.status, data.state, data.sending?.status, data.sending?.state];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

// Safe, non-secret view of the SigmaSMS configuration for an admin diagnostics
// endpoint. Reports whether a token is present and its LENGTH only — never the
// token itself, and never request headers.
export interface SmsDiagnostics {
  provider: string;
  configured: boolean;
  tokenLength: number;
  sender: string;
  apiBase: string;
}

export function getSmsDiagnostics(): SmsDiagnostics {
  const provider = smsProvider();
  if (provider === "sigmasms") {
    const token = sigmaSmsToken();
    return {
      provider,
      configured: token.length > 0,
      tokenLength: token.length,
      sender: sigmaSmsSender(),
      apiBase: `${sigmaSmsApiBase()}/sendings`,
    };
  }
  if (provider === "smsru") {
    const token = (process.env.SMSRU_API_ID || "").trim();
    return {
      provider,
      configured: token.length > 0,
      tokenLength: token.length,
      sender: "",
      apiBase: "https://sms.ru/sms/send",
    };
  }
  // No provider configured — dev fallback.
  return { provider: provider || "(none)", configured: false, tokenLength: 0, sender: "", apiBase: "" };
}

// SigmaSMS returns a textual status per sending. Anything that clearly denotes
// rejection is treated as a failure; queued/sent/delivered are accepted. Unknown
// values are treated as accepted (the API took the request).
function isSigmaSmsFailedStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const s = status.trim().toLowerCase();
  return s === "error" || s === "failed" || s === "rejected" || s === "undeliverable";
}

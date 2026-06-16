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
    return { devEcho: false };
  }

  if (provider === "sigmasms") {
    await sendViaSigmaSms(phone, code);
    return { devEcho: false };
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
      recipient: phone,
      type: "sms",
      payload: { sender: sigmaSmsSender(), text: otpMessage(code) },
    },
  };
}

// fetch-compatible signature so a smoke test can inject a mock.
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export async function sendViaSigmaSms(
  phone: string,
  code: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
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
  // the message was not accepted. We never echo the provider error verbatim to
  // the rider; logs carry the status (no token, no message text).
  if (!res.ok || data?.error || isSigmaSmsFailedStatus(data?.status)) {
    log(`[sms:sigmasms] request rejected: http=${res.status} status=${data?.status ?? "?"}`, "sms");
    throw new Error("Не удалось отправить SMS. Попробуйте позже.");
  }
}

// SigmaSMS returns a textual status per sending. Anything that clearly denotes
// rejection is treated as a failure; queued/sent/delivered are accepted. Unknown
// values are treated as accepted (the API took the request).
function isSigmaSmsFailedStatus(status: unknown): boolean {
  if (typeof status !== "string") return false;
  const s = status.trim().toLowerCase();
  return s === "error" || s === "failed" || s === "rejected" || s === "undeliverable";
}

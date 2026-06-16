// T-Bank / T-Kassa (Tinkoff) classic acquiring client.
//
// Stage 1 integration: card binding (AddCard) and payment creation (Init),
// plus notification token verification. Credentials are read from the
// environment at runtime and are NEVER hardcoded or logged:
//   TBANK_TERMINAL_KEY  — terminal key (public-ish identifier)
//   TBANK_PASSWORD      — terminal password (secret; used only for the token)
//   TBANK_API_BASE      — API base, defaults to the production acquiring host
//   PUBLIC_APP_URL      — our public origin, used to build Success/Fail/Notify
//   TBANK_ADD_CARD_CHECK_TYPE — AddCard CheckType (NO/HOLD/3DS/3DSHOLD),
//                               defaults to 3DS
//
// If the terminal key or password is missing the client reports "not
// configured" so routes can answer 503 instead of crashing. The password is
// only ever fed into the SHA-256 token and is never returned, logged, or sent
// to the client.

import { createHash } from "node:crypto";

// Local logger. We intentionally do NOT import the logger from ./index, because
// importing index boots the HTTP server (top-level listen). Keeping logging
// self-contained here lets the token logic be unit-tested in isolation.
function log(message: string, source = "tbank"): void {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${time} [${source}] ${message}`);
}

const DEFAULT_API_BASE = "https://securepay.tinkoff.ru/v2";
const DEFAULT_PUBLIC_APP_URL = "https://takeride.ru";

export type CardCheckType = "NO" | "HOLD" | "3DS" | "3DSHOLD";
const DEFAULT_ADD_CARD_CHECK_TYPE: CardCheckType = "3DS";
const VALID_CHECK_TYPES: readonly CardCheckType[] = ["NO", "HOLD", "3DS", "3DSHOLD"];

export interface TbankConfig {
  terminalKey: string;
  password: string;
  apiBase: string;
  publicAppUrl: string;
  // Default CheckType for AddCard. Env-configurable so a test terminal that
  // rejects 3DS binding can fall back to NO without a code change.
  addCardCheckType: CardCheckType;
}

// Resolve the runtime config from the environment. Returns null when the
// terminal key or password is absent so callers can fail gracefully (503)
// rather than attempting a doomed request.
export function getTbankConfig(): TbankConfig | null {
  const terminalKey = (process.env.TBANK_TERMINAL_KEY || "").trim();
  const password = (process.env.TBANK_PASSWORD || "").trim();
  if (!terminalKey || !password) return null;

  const apiBase = (process.env.TBANK_API_BASE || "").trim() || DEFAULT_API_BASE;
  const publicAppUrl = (process.env.PUBLIC_APP_URL || "").trim() || DEFAULT_PUBLIC_APP_URL;
  return {
    terminalKey,
    password,
    // Strip any trailing slash so we can join paths predictably.
    apiBase: apiBase.replace(/\/+$/, ""),
    publicAppUrl: publicAppUrl.replace(/\/+$/, ""),
    addCardCheckType: parseCheckType(process.env.TBANK_ADD_CARD_CHECK_TYPE),
  };
}

// Parse the configured AddCard CheckType, falling back to the default for an
// empty or unrecognized value (case-insensitive). Keeping this permissive
// avoids a doomed request with an invalid CheckType the acquirer would reject.
export function parseCheckType(raw: string | undefined): CardCheckType {
  const v = (raw || "").trim().toUpperCase();
  const match = VALID_CHECK_TYPES.find((t) => t === v);
  return match ?? DEFAULT_ADD_CARD_CHECK_TYPE;
}

export function isTbankConfigured(): boolean {
  return getTbankConfig() !== null;
}

// Values eligible for the token are scalars only. Nested objects/arrays (e.g.
// Receipt, DATA) are excluded from the signature per the T-Kassa spec, as is
// the Token field itself.
type Scalar = string | number | boolean | null | undefined;
export type TbankParams = Record<string, Scalar | Record<string, unknown> | unknown[]>;

function isScalar(v: unknown): v is Scalar {
  return (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

// Compute the T-Kassa request/notification token.
//
// Algorithm (classic acquiring):
//   1. Take only the ROOT-LEVEL scalar params (drop nested objects/arrays and
//      any existing Token field).
//   2. Add a `Password` entry whose value is the terminal password.
//   3. Sort the pairs by key (ascending).
//   4. Concatenate the values in that order into a single string.
//   5. SHA-256 the string; the lowercase hex digest is the Token.
//
// The same routine verifies inbound notifications (which include their own
// Token) by recomputing over the notification's root scalar fields.
export function computeToken(params: TbankParams, password: string): string {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (key === "Token") continue;
    if (!isScalar(value)) continue; // skip nested objects/arrays
    if (value === undefined || value === null) continue;
    entries.push([key, stringifyScalar(value)]);
  }
  entries.push(["Password", password]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const concatenated = entries.map(([, v]) => v).join("");
  return createHash("sha256").update(concatenated, "utf8").digest("hex");
}

// Booleans serialize as the lowercase literals T-Kassa expects in the token.
function stringifyScalar(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

// Verify an inbound notification's Token against the recomputed signature.
// Returns false when the token is missing or does not match.
export function verifyNotificationToken(body: Record<string, unknown>, password: string): boolean {
  const provided = body?.Token;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const expected = computeToken(body as TbankParams, password);
  // Both are hex digests of fixed length; a plain compare is sufficient and the
  // value is not secret (the attacker would need the password to forge it).
  return provided.toLowerCase() === expected.toLowerCase();
}

export interface TbankResponse {
  Success: boolean;
  ErrorCode?: string;
  Message?: string;
  Details?: string;
  Status?: string;
  PaymentId?: string | number;
  OrderId?: string;
  PaymentURL?: string;
  CustomerKey?: string;
  RequestKey?: string;
  [k: string]: unknown;
}

// Low-level signed POST to a T-Kassa endpoint. Injects TerminalKey + Token,
// sends JSON, and returns the parsed response. Throws a generic Error on
// transport failure; the password is never included in any thrown message.
async function signedPost(
  cfg: TbankConfig,
  path: string,
  params: TbankParams,
): Promise<TbankResponse> {
  const withTerminal: TbankParams = { TerminalKey: cfg.terminalKey, ...params };
  const token = computeToken(withTerminal, cfg.password);
  const payload = { ...withTerminal, Token: token };

  const url = `${cfg.apiBase}${path}`;
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    log(`[tbank] transport error calling ${path}`, "tbank");
    throw new Error("Платёжный сервис временно недоступен. Попробуйте позже.");
  }

  let data: TbankResponse;
  try {
    data = (await res.json()) as TbankResponse;
  } catch {
    log(`[tbank] non-JSON response from ${path} (HTTP ${res.status})`, "tbank");
    throw new Error("Платёжный сервис вернул некорректный ответ. Попробуйте позже.");
  }

  // Log the outcome WITHOUT the request payload (which carries the token) so
  // nothing sensitive is written to logs.
  if (!data.Success) {
    log(`[tbank] ${path} rejected: ${data.ErrorCode ?? "?"} ${data.Message ?? ""}`, "tbank");
  }
  return data;
}

// ---------- High-level operations ----------

export interface AddCardInput {
  customerKey: string;
  // 3DS card binding. "3DS" runs the binding through 3-D Secure (recommended);
  // other valid values are NO, 3DSHOLD, HOLD. Defaults to cfg.addCardCheckType
  // (TBANK_ADD_CARD_CHECK_TYPE) when omitted.
  checkType?: CardCheckType;
  // Optional override URLs; default to PUBLIC_APP_URL-derived endpoints. The
  // rider is returned to /payment-methods after the hosted form; binding
  // results arrive asynchronously on the notification endpoint.
  successUrl?: string;
  failUrl?: string;
  notificationUrl?: string;
}

// Initiate card binding for a customer. Returns a PaymentURL the rider opens to
// enter their card on T-Bank's hosted form (we never see the PAN/CVC).
//
// NOTE: AddCard uses its own redirect-URL field names — SuccessAddCardURL and
// FailAddCardURL — NOT the generic SuccessURL/FailURL used by Init. Using the
// generic names leaves the binding without return URLs, which is the root cause
// of the hosted form failing to complete the redirect back to the app.
export async function tbankAddCard(cfg: TbankConfig, input: AddCardInput): Promise<TbankResponse> {
  return signedPost(cfg, "/AddCard", {
    CustomerKey: input.customerKey,
    CheckType: input.checkType ?? cfg.addCardCheckType,
    SuccessAddCardURL: input.successUrl ?? `${cfg.publicAppUrl}/payment-methods`,
    FailAddCardURL: input.failUrl ?? `${cfg.publicAppUrl}/payment-methods`,
    NotificationURL: input.notificationUrl ?? `${cfg.publicAppUrl}/api/payments/tbank/notification`,
  });
}

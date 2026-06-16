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

import { createHash, randomInt } from "node:crypto";

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

// Default amount (in kopecks) for the verification payment used to bind a card
// via Init+Recurrent. 100 kopecks = 1 ₽. Overridable with
// TBANK_CARD_BIND_AMOUNT_KOPEKS for terminals that require a different minimum.
const DEFAULT_CARD_BIND_AMOUNT_KOPEKS = 100;

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
  // Amount (in kopecks) for the Init+Recurrent verification payment used to bind
  // a card. Env-configurable (TBANK_CARD_BIND_AMOUNT_KOPEKS), default 100 (1 ₽).
  cardBindAmountKopecks: number;
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
    cardBindAmountKopecks: parseBindAmount(process.env.TBANK_CARD_BIND_AMOUNT_KOPEKS),
  };
}

// Parse the configured verification-payment amount (kopecks). Falls back to the
// default for an empty, non-numeric, zero, or negative value so a misconfigured
// env never produces an Init request the acquirer would reject. Truncates to a
// whole number of kopecks (Init.Amount must be an integer).
export function parseBindAmount(raw: string | undefined): number {
  const n = Number((raw || "").trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CARD_BIND_AMOUNT_KOPEKS;
  return Math.floor(n);
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

// Non-secret diagnostics for operators to confirm the terminal is wired up
// correctly WITHOUT exposing any secret. Crucially this never returns the
// password or the full terminal key — only lengths and a short suffix, which is
// enough to spot a truncated/whitespace-mangled value (e.g. a password whose
// leading `$` was eaten by shell/compose interpolation would show a shorter
// length than expected) without leaking anything usable.
export interface TbankDiagnostics {
  configured: boolean;
  apiBase?: string;
  checkType?: CardCheckType;
  terminalKeyLength?: number;
  terminalKeyLast4?: string;
  passwordLength?: number;
  // True when the configured password contains a `$`. A surprising false here
  // (when you set a $-prefixed password) is a strong signal that env/compose
  // interpolation stripped it. We expose only the boolean, never the value.
  passwordHasDollar?: boolean;
  publicAppUrl?: string;
  cardBindAmountKopecks?: number;
}

export function getTbankDiagnostics(): TbankDiagnostics {
  const cfg = getTbankConfig();
  if (!cfg) return { configured: false };
  return {
    configured: true,
    apiBase: cfg.apiBase,
    checkType: cfg.addCardCheckType,
    terminalKeyLength: cfg.terminalKey.length,
    terminalKeyLast4: cfg.terminalKey.slice(-4),
    passwordLength: cfg.password.length,
    passwordHasDollar: cfg.password.includes("$"),
    publicAppUrl: cfg.publicAppUrl,
    cardBindAmountKopecks: cfg.cardBindAmountKopecks,
  };
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

// Drop null/undefined/empty-string scalar fields so they participate in neither
// the token nor the request body. Nested objects/arrays are passed through
// untouched (they never take part in the token but may be valid payload, e.g.
// Receipt/DATA). Keeping the signed set === the sent set is what prevents code
// 204 "invalid token".
function pruneEmpty(params: TbankParams): TbankParams {
  const out: TbankParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.length === 0) continue;
    out[key] = value;
  }
  return out;
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
//
// The token is computed over the EXACT final payload that goes on the wire
// (minus any null/undefined fields, which are dropped before both signing and
// serialization). This guarantees the signed set and the sent set are identical
// — a mismatch here is the classic cause of T-Kassa code 204 "invalid token".
async function signedPost(
  cfg: TbankConfig,
  path: string,
  params: TbankParams,
): Promise<TbankResponse> {
  // Build the final root-level param set, then drop empty values so they are
  // neither signed nor sent (T-Kassa signs only the fields present in the body).
  const finalParams = pruneEmpty({ TerminalKey: cfg.terminalKey, ...params });
  const token = computeToken(finalParams, cfg.password);
  const payload = { ...finalParams, Token: token };

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
}

// Initiate card binding for a customer. Returns a PaymentURL the rider opens to
// enter their card on T-Bank's hosted form (we never see the PAN/CVC).
//
// IMPORTANT — token correctness: the /AddCard method accepts ONLY TerminalKey,
// CustomerKey, CheckType (plus optional IP/ResidentState) per the T-Bank spec
// (developer.tbank.ru/eacq/api/add-card). The redirect fields SuccessAddCardURL
// / FailAddCardURL / NotificationURL are NOT AddCard parameters — they belong to
// Init. Sending them here folds them into our SHA-256 token while T-Bank signs
// only its own known field set, so the signatures never match and the acquirer
// answers code 204 "invalid token". Those URLs are configured on the terminal
// in the merchant cabinet; binding results still arrive on our notification
// endpoint. We therefore sign and send exactly the documented AddCard fields.
export async function tbankAddCard(cfg: TbankConfig, input: AddCardInput): Promise<TbankResponse> {
  return signedPost(cfg, "/AddCard", {
    CustomerKey: input.customerKey,
    CheckType: input.checkType ?? cfg.addCardCheckType,
  });
}

// T-Bank rejects an OrderId longer than 50 chars (Init error code 212,
// "OrderId length must be 1..50"). A UUID user id alone is 36 chars, so the old
// `bind-${uuid}-${Date.now()}` form was ~55 chars and always failed. We build a
// compact, collision-resistant id instead: a short prefix, a base36 millisecond
// timestamp, and a random base36 suffix. Result is ASCII (latin/digits/dash)
// only — no spaces or unicode — and well under 50 chars.
export function generateBindOrderId(): string {
  const ts = Date.now().toString(36); // ~8 chars through year ~2059
  let rand = "";
  while (rand.length < 6) rand += randomInt(36).toString(36);
  return `TRCB-${ts}-${rand.slice(0, 6)}`; // e.g. TRCB-lk3p9q2-a8f1zq (~20 chars)
}

export interface InitBindCardInput {
  // Our order id for this binding payment (unique per attempt). Echoed back in
  // notifications so we can correlate the payment to the pending method.
  orderId: string;
  // Amount in kopecks for the verification payment (e.g. 100 = 1 ₽).
  amountKopecks: number;
  // CustomerKey ties the saved card to the rider; required together with
  // Recurrent=Y so a RebillId is issued for future charges.
  customerKey: string;
  description: string;
  successUrl: string;
  failUrl: string;
  notificationUrl: string;
}

// Create a payment via /Init with Recurrent=Y to bind a card through a small
// verification payment. This is the more reliable binding path than AddCard on
// test/sandbox terminals: the rider pays a tiny amount (e.g. 1 ₽) on T-Bank's
// hosted form, and because Recurrent=Y + CustomerKey are set, the acquirer
// issues a RebillId we can use for future recurring charges. Returns a
// PaymentURL the rider opens; the PAN/CVC are entered only on T-Bank's form.
//
// Token correctness: Init signs only ROOT-LEVEL scalar params. We pass the
// documented Init fields (TerminalKey is injected by signedPost) — Amount,
// OrderId, Description, CustomerKey, Recurrent, plus the redirect/notify URLs,
// which ARE valid Init parameters (unlike AddCard). signedPost signs the exact
// payload sent, so the signed set === the sent set (avoids code 204).
export async function tbankInitBindCard(
  cfg: TbankConfig,
  input: InitBindCardInput,
): Promise<TbankResponse> {
  return signedPost(cfg, "/Init", {
    Amount: input.amountKopecks,
    OrderId: input.orderId,
    Description: input.description,
    CustomerKey: input.customerKey,
    Recurrent: "Y",
    SuccessURL: input.successUrl,
    FailURL: input.failUrl,
    NotificationURL: input.notificationUrl,
  });
}

// Poll the status of a card binding started with AddCard. The acquirer accepts
// ONLY TerminalKey + RequestKey (plus the injected Token) for /GetAddCardState
// per the T-Bank spec (developer.tbank.ru/eacq). Sending anything else would
// fold extra fields into our token while T-Bank signs only its own set — the
// same code 204 "invalid token" trap as AddCard — so we sign and send exactly
// RequestKey. On success the response carries Status, and once the card is
// bound, CardId (and RebillId for HOLD/3DS). Used to resolve a method stuck on
// "pending" when the notification webhook never arrived.
export async function tbankGetAddCardState(
  cfg: TbankConfig,
  requestKey: string,
): Promise<TbankResponse> {
  return signedPost(cfg, "/GetAddCardState", { RequestKey: requestKey });
}

// Map a T-Bank AddCard binding response/notification to our lifecycle status.
// A binding is "active" once the acquirer returns a CardId or a COMPLETED
// status; it is "failed" on an explicit terminal rejection; everything else is
// still in flight ("pending"). Keeping this in one place lets the notification
// webhook and the GetAddCardState poller agree on what each state means.
export type CardBindingOutcome = "active" | "failed" | "pending";

const FAILED_BINDING_STATUSES: readonly string[] = [
  "REJECTED",
  "DEADLINE_EXPIRED",
  "AUTH_FAIL",
  "CANCELED",
  "CANCELLED",
];

export function classifyCardBinding(args: {
  status?: string;
  cardId?: string;
}): CardBindingOutcome {
  const status = (args.status || "").trim().toUpperCase();
  if (args.cardId || status === "COMPLETED" || status === "AUTHORIZED" || status === "CONFIRMED") {
    return "active";
  }
  if (FAILED_BINDING_STATUSES.includes(status)) return "failed";
  return "pending";
}

// Map an Init verification-payment notification/state to our card-binding
// lifecycle. The card is bound once the payment reaches AUTHORIZED/CONFIRMED
// *and* the acquirer returned a RebillId (the recurring token we actually need
// for future charges). It is "failed" on an explicit terminal rejection or
// Success=false; everything else is still in flight ("pending").
export function classifyInitBinding(args: {
  status?: string;
  rebillId?: string;
  success?: boolean;
}): CardBindingOutcome {
  const status = (args.status || "").trim().toUpperCase();
  if (args.rebillId && (status === "AUTHORIZED" || status === "CONFIRMED")) {
    return "active";
  }
  if (args.success === false || FAILED_BINDING_STATUSES.includes(status)) {
    return "failed";
  }
  return "pending";
}

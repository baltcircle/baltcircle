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
  // Which binding method to prefer. Env-configurable via TBANK_CARD_BIND_METHOD:
  //   "payment" (default) — Init+Recurrent 1 ₽ verification charge, then a
  //                          reliable reversal/refund. Works on terminals where
  //                          AddCard does not issue a RebillId.
  //   "addcard"           — AddCard: bind the card with NO charge at all. Use
  //                          only when the terminal issues a RebillId via AddCard
  //                          (otherwise recurring charges have no token). Swap by
  //                          env, no code change.
  cardBindMethod: CardBindMethod;
}

// Card-binding method selector. "payment" = Init+Recurrent 1 ₽ charge (default);
// "addcard" = AddCard with no charge.
export type CardBindMethod = "payment" | "addcard";

// Parse TBANK_CARD_BIND_METHOD. Defaults to "payment" (the safe, RebillId-
// guaranteed path) for any empty/unknown value.
export function parseCardBindMethod(raw: string | undefined): CardBindMethod {
  return (raw || "").trim().toLowerCase() === "addcard" ? "addcard" : "payment";
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
    cardBindMethod: parseCardBindMethod(process.env.TBANK_CARD_BIND_METHOD),
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
  // SBP (AddAccountQr) — the QR payload / deeplink / base64 image is returned in
  // `Data` (its exact shape depends on the requested DataType). Some acquirer
  // builds echo a QrCodeData/Payload field too; we read whichever is present.
  Data?: unknown;
  QrCodeData?: unknown;
  Payload?: unknown;
  // SBP account binding token (issued by the payer's bank, arrives in the
  // binding notification / GetAddAccountQrState once the account is ACTIVE).
  AccountToken?: string;
  BankMemberId?: string;
  BankMemberName?: string;
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
// OrderId, Description, CustomerKey, Recurrent, OperationInitiatorType, plus the
// redirect/notify URLs, which ARE valid Init parameters (unlike AddCard).
// signedPost signs the exact payload sent, so the signed set === the sent set
// (avoids code 204).
//
// OperationInitiatorType=1 (CIT CC — customer-initiated, credential-captured)
// is required alongside Recurrent=Y so the acquirer registers this as the PARENT
// operation that captures the card credential for future MIT (merchant-initiated)
// recurring charges. Per the T-Bank spec the RebillId/Recurrent/
// OperationInitiatorType triad must be consistent or MAPI rejects the request;
// for the parent credential-capture payment the matching value is 1.
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
    OperationInitiatorType: "1",
    SuccessURL: input.successUrl,
    FailURL: input.failUrl,
    NotificationURL: input.notificationUrl,
  });
}

// Build a compact, collision-resistant OrderId for an ordinary ride payment.
// Same constraints as generateBindOrderId — must stay <= 50 chars (T-Bank Init
// rejects longer with code 212) and contain only ASCII latin/digits/dash. We
// use a distinct "TRRP" (TakeRide Ride Payment) prefix so the notification
// handler can tell ride payments apart from card-binding orders at a glance.
export function generateRideOrderId(): string {
  const ts = Date.now().toString(36); // ~8 chars through year ~2059
  let rand = "";
  while (rand.length < 6) rand += randomInt(36).toString(36);
  return `TRRP-${ts}-${rand.slice(0, 6)}`; // e.g. TRRP-lk3p9q2-a8f1zq (~20 chars)
}

export interface InitRidePaymentInput {
  // Our order id for this ride payment (unique per attempt, <= 50 chars).
  orderId: string;
  // Amount in kopecks for the tariff (e.g. 35000 = 350 ₽).
  amountKopecks: number;
  description: string;
  successUrl: string;
  failUrl: string;
  notificationUrl: string;
  // Optional CustomerKey ties the payment to the rider in T-Bank's cabinet. It
  // is NOT required for an ordinary (non-recurring) payment and carries no card
  // data; we pass our user id so payments are attributable in the merchant UI.
  customerKey?: string;
}

// Create an ordinary (one-off) payment via /Init for a ride. Unlike the
// card-binding path this sends NO Recurrent=Y and expects NO RebillId back —
// the rider simply pays the tariff up front on T-Bank's hosted form (PAN/CVC
// never reach us). On CONFIRMED/AUTHORIZED the notification webhook starts the
// ride. Returns the PaymentURL the rider opens.
//
// Token correctness: Init signs only ROOT-LEVEL scalar params. We sign and send
// exactly the documented Init fields (TerminalKey is injected by signedPost),
// so the signed set === the sent set (avoids code 204 "invalid token").
export async function tbankInitRidePayment(
  cfg: TbankConfig,
  input: InitRidePaymentInput,
): Promise<TbankResponse> {
  return signedPost(cfg, "/Init", {
    Amount: input.amountKopecks,
    OrderId: input.orderId,
    Description: input.description,
    CustomerKey: input.customerKey,
    SuccessURL: input.successUrl,
    FailURL: input.failUrl,
    NotificationURL: input.notificationUrl,
  });
}

// Build a compact, collision-resistant OrderId for a SAVED-CARD ride payment
// (recurring charge via a stored RebillId). Same constraints as the other
// generators — <= 50 chars, ASCII latin/digits/dash only. A distinct "TRSC"
// (TakeRide Saved Card) prefix lets the notification handler/logs tell a
// recurring saved-card charge apart from a hosted ride payment at a glance.
export function generateSavedCardRideOrderId(): string {
  const ts = Date.now().toString(36); // ~8 chars through year ~2059
  let rand = "";
  while (rand.length < 6) rand += randomInt(36).toString(36);
  return `TRSC-${ts}-${rand.slice(0, 6)}`; // e.g. TRSC-lk3p9q2-a8f1zq (~20 chars)
}

export interface InitSavedCardChargeInput {
  // Our order id for this saved-card charge (unique per attempt, <= 50 chars).
  orderId: string;
  // Amount in kopecks for the tariff (e.g. 35000 = 350 ₽).
  amountKopecks: number;
  description: string;
  // CustomerKey ties the charge to the rider whose card we're charging; it must
  // match the CustomerKey the RebillId was issued under.
  customerKey: string;
  // Where T-Bank POSTs the asynchronous result (CONFIRMED/REJECTED). The Charge
  // call below is usually synchronous, but a NotificationURL keeps us correct if
  // the acquirer defers (e.g. 3DS step-up on a recurring charge).
  notificationUrl: string;
}

// Create the payment object for a recurring (merchant-initiated) charge against
// a SAVED card via /Init, then /Charge with the RebillId. This is the two-step
// recurrent flow: Init registers the payment (NO Recurrent=Y — that flag is only
// for the PARENT credential-capturing payment) and returns a PaymentId; Charge
// then debits the stored card using PaymentId + RebillId without the rider
// re-entering any card data.
//
// OperationInitiatorType="R" marks this as MIT (merchant-initiated) recurring,
// the value required by the T-Bank spec for a recurring charge that reuses a
// previously captured credential (the parent capture used "1"/CIT). Token
// correctness: Init signs only ROOT-LEVEL scalar params and signedPost signs the
// exact payload sent, so the signed set === the sent set (avoids code 204).
export async function tbankInitSavedCardCharge(
  cfg: TbankConfig,
  input: InitSavedCardChargeInput,
): Promise<TbankResponse> {
  return signedPost(cfg, "/Init", {
    Amount: input.amountKopecks,
    OrderId: input.orderId,
    Description: input.description,
    CustomerKey: input.customerKey,
    OperationInitiatorType: "R",
    NotificationURL: input.notificationUrl,
  });
}

export interface ChargeInput {
  // PaymentId returned by the preceding Init for this charge.
  paymentId: string;
  // The stored recurring token issued when the rider's card was bound.
  rebillId: string;
}

// Debit a saved card via /Charge using the PaymentId from Init plus the stored
// RebillId. No card data is involved — the RebillId is the recurring token. On
// success the response Status is AUTHORIZED/CONFIRMED (synchronous capture);
// classifyRidePayment maps those to "paid". A deferred/3DS charge returns a
// non-terminal status and the result arrives later on the NotificationURL.
//
// Token correctness: Charge signs only ROOT-LEVEL scalar params (TerminalKey is
// injected by signedPost); we sign and send exactly PaymentId + RebillId so the
// signed set === the sent set (avoids code 204 "invalid token").
export async function tbankCharge(cfg: TbankConfig, input: ChargeInput): Promise<TbankResponse> {
  return signedPost(cfg, "/Charge", {
    PaymentId: input.paymentId,
    RebillId: input.rebillId,
  });
}

// Map an ordinary ride-payment notification/state to our order lifecycle. The
// payment is "paid" once it reaches AUTHORIZED or CONFIRMED (we start the ride
// on either — AUTHORIZED is a held auth, CONFIRMED a captured one; for the MVP
// both mean the rider has committed funds). It is "failed" on an explicit
// terminal rejection or Success=false; everything else is still in flight.
export type RidePaymentOutcome = "paid" | "failed" | "pending";

export function classifyRidePayment(args: {
  status?: string;
  success?: boolean;
}): RidePaymentOutcome {
  const status = (args.status || "").trim().toUpperCase();
  if (status === "AUTHORIZED" || status === "CONFIRMED") return "paid";
  if (args.success === false || FAILED_BINDING_STATUSES.includes(status)) {
    return "failed";
  }
  return "pending";
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

// Poll the status of a payment created with Init by its PaymentId. /GetState
// accepts ONLY TerminalKey + PaymentId (plus the injected Token) per the T-Bank
// spec — sending extra fields would fold them into our token while T-Bank signs
// only its own set (the same code 204 "invalid token" trap), so we sign and send
// exactly PaymentId. On success the response carries Status and, for a
// Recurrent=Y verification payment, a RebillId (the recurring token) plus
// CardId/Pan when available. Used to resolve an Init-bind method stuck on
// "pending" when the notification webhook never arrived (the Init flow has a
// PaymentId but no RequestKey, so GetAddCardState cannot resolve it).
export async function tbankGetState(
  cfg: TbankConfig,
  paymentId: string,
): Promise<TbankResponse> {
  return signedPost(cfg, "/GetState", { PaymentId: paymentId });
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

// Outcome of cancelling/refunding the 1 ₽ verification charge. "refunded" means
// the money is back with the rider (a reversal of an AUTHORIZED hold — which
// never debited and so does NOT show up in the cabinet's "Возвраты" list — or a
// true refund of a CONFIRMED payment, which does). "nothing_to_cancel" means the
// payment was already reversed/refunded/rejected, so no money is outstanding.
// "failed" means the reversal could not complete and the 1 ₽ may be stuck.
export type CancelOutcome =
  | { result: "refunded"; status: string }
  | { result: "nothing_to_cancel"; status: string }
  | { result: "failed"; reason: string };

// A single raw /Cancel call. For an AUTHORIZED payment this is a reversal (the
// hold is released; nothing was debited). For a CONFIRMED payment this is a
// refund (a real credit that appears in the cabinet). T-Bank picks the right
// operation from the payment's current stage — we only send PaymentId.
async function cancelOnce(cfg: TbankConfig, paymentId: string): Promise<TbankResponse> {
  return signedPost(cfg, "/Cancel", { PaymentId: paymentId });
}

// Statuses for which a Cancel is a no-op because there is nothing to give back:
// the payment never captured funds (REJECTED/rejected auth) or was already
// reversed/refunded. Treated as success — no money is outstanding.
const ALREADY_SETTLED_STATUSES: readonly string[] = [
  "CANCELED",
  "CANCELLED",
  "REVERSED",
  "REFUNDED",
  "PARTIAL_REFUNDED",
  "REJECTED",
  "AUTH_FAIL",
  "DEADLINE_EXPIRED",
];

// Robustly reverse/refund the 1 ₽ verification charge and REPORT the outcome.
//
// Why this is not a fire-and-forget one-liner: a plain /Cancel on a payment that
// has not settled yet, or a transient acquirer error, silently leaves the rider's
// 1 ₽ charged. So we:
//   1. Read the current status via /GetState (unless we already know it).
//   2. Skip if the payment already settled/reversed (nothing to give back).
//   3. Call /Cancel with a few retries for transient failures.
//   4. Return a structured outcome so the caller can PERSIST refund state and a
//      stuck 1 ₽ becomes observable in the DB/UI instead of only in logs.
export async function tbankRefundVerificationCharge(
  cfg: TbankConfig,
  paymentId: string,
  knownStatus?: string,
): Promise<CancelOutcome> {
  if (!paymentId) return { result: "failed", reason: "нет PaymentId для возврата" };

  // 1. Determine the current status (skip the extra call if the caller already
  //    passed a fresh one from the same notification/GetState).
  let status = (knownStatus || "").trim().toUpperCase();
  if (!status) {
    try {
      const state = await tbankGetState(cfg, paymentId);
      if (state.Success && typeof state.Status === "string") {
        status = state.Status.trim().toUpperCase();
      }
    } catch (err: any) {
      // Non-fatal — proceed to Cancel anyway; the acquirer reports the true
      // state in the Cancel response.
      log(`[tbank] refund GetState error for PaymentId=${paymentId}: ${err?.message}`, "tbank");
    }
  }

  // 2. Nothing to reverse — already settled/reversed/rejected.
  if (status && ALREADY_SETTLED_STATUSES.includes(status)) {
    log(`[tbank] refund skip PaymentId=${paymentId}: already ${status}`, "tbank");
    return { result: "nothing_to_cancel", status };
  }

  // 3. Cancel with retries for transient failures (network / acquirer 5xx-style).
  const maxAttempts = 3;
  let lastReason = "неизвестная ошибка";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await cancelOnce(cfg, paymentId);
      if (resp.Success) {
        const newStatus =
          typeof resp.Status === "string" ? resp.Status.trim().toUpperCase() : status || "CANCELED";
        log(`[tbank] refund OK PaymentId=${paymentId} (attempt ${attempt}, status ${newStatus})`, "tbank");
        return { result: "refunded", status: newStatus };
      }
      // Success=false. If the acquirer says it's already reversed/refunded, treat
      // as done rather than a failure (idempotent double-cancel is harmless).
      const respStatus = typeof resp.Status === "string" ? resp.Status.trim().toUpperCase() : "";
      if (respStatus && ALREADY_SETTLED_STATUSES.includes(respStatus)) {
        log(`[tbank] refund PaymentId=${paymentId}: acquirer reports already ${respStatus}`, "tbank");
        return { result: "nothing_to_cancel", status: respStatus };
      }
      lastReason = String(resp.Message ?? resp.Details ?? resp.ErrorCode ?? "Cancel отклонён");
      log(`[tbank] refund attempt ${attempt}/${maxAttempts} failed PaymentId=${paymentId}: ${lastReason}`, "tbank");
    } catch (err: any) {
      lastReason = String(err?.message ?? "сетевая ошибка");
      log(`[tbank] refund attempt ${attempt}/${maxAttempts} error PaymentId=${paymentId}: ${lastReason}`, "tbank");
    }
    // brief backoff before the next attempt (skip after the last one)
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 400 * attempt));
  }

  log(`[tbank] refund GIVE UP PaymentId=${paymentId}: ${lastReason} — 1 ₽ may be stuck`, "tbank");
  return { result: "failed", reason: lastReason };
}

// Backwards-compatible thin wrapper. Prefer tbankRefundVerificationCharge, which
// returns a structured outcome the caller can persist. Kept so existing
// fire-and-forget call sites still compile; it delegates and ignores the result.
export async function tbankCancel(
  cfg: TbankConfig,
  paymentId: string,
): Promise<void> {
  await tbankRefundVerificationCharge(cfg, paymentId);
}

// ---------- SBP (СБП) account binding & recurring charge ----------
//
// The СБП analogue of the card RebillId flow. Instead of a card + RebillId we
// bind the rider's bank ACCOUNT and receive an AccountToken, then debit it later
// with ChargeQr. Flow:
//   1. AddAccountQr        → returns a QR payload / deeplink the rider opens in
//                            their bank app to authorise the account binding, plus
//                            a RequestKey to poll the binding state.
//   2. (notification)      → T-Bank POSTs the binding result to our webhook with
//                            an AccountToken once the account is ACTIVE.
//   3. GetAddAccountQrState→ recovery poll (by RequestKey) when the webhook never
//                            arrived; returns Status + AccountToken when ACTIVE.
//   4. Init (DATA={QR:true},
//      Recurrent=Y) + ChargeQr(AccountToken) → later recurring debit.
//
// Token correctness (the classic code 204 trap): signedPost signs the EXACT
// root-level scalar payload it sends. AddAccountQr's `Data` is a nested object,
// so it is excluded from the token by design (isScalar drops it) yet still sent
// — identical to how Receipt/DATA are handled elsewhere. We therefore sign and
// send exactly the documented fields.

export interface AddAccountQrInput {
  // Ties the bound account to the rider in T-Bank's cabinet (== our user id),
  // mirroring the CustomerKey we use for card binding.
  customerKey: string;
  description: string;
  // "PAYLOAD" returns a functional payment link/deeplink (default); "IMAGE"
  // returns a base64 QR image. We request PAYLOAD and render the QR client-side
  // so we can also offer an "open in bank" deeplink button on mobile.
  dataType?: "PAYLOAD" | "IMAGE";
}

// Initiate an SBP account binding. Returns a RequestKey (to poll the state) and
// a Data payload (the QR/deeplink the rider opens in their bank app). The
// AccountToken itself does NOT come back here — it arrives in the binding
// notification once the payer authorises it in their bank.
export async function tbankAddAccountQr(
  cfg: TbankConfig,
  input: AddAccountQrInput,
): Promise<TbankResponse> {
  return signedPost(cfg, "/AddAccountQr", {
    // Description is shown in the rider's bank app; DataType selects PAYLOAD vs
    // IMAGE. The binding is correlated to the rider via our own pending row keyed
    // by the returned RequestKey. (CustomerKey is not a documented AddAccountQr
    // field — sending it would break the token, the same code 204 trap.)
    Description: input.description,
    DataType: input.dataType ?? "PAYLOAD",
  });
}

// Poll the state of an SBP account binding started with AddAccountQr. Accepts
// ONLY TerminalKey + RequestKey (plus the injected Token) per the T-Bank spec
// (developer.tbank.ru/eacq/api/get-add-account-qr-state) — sending extra fields
// would fold them into our token while T-Bank signs only its own set (code 204).
// On success returns Status (NEW/PROCESSING/ACTIVE/INACTIVE) and, once ACTIVE,
// the AccountToken (+ BankMemberId/BankMemberName).
export async function tbankGetAddAccountQrState(
  cfg: TbankConfig,
  requestKey: string,
): Promise<TbankResponse> {
  return signedPost(cfg, "/GetAddAccountQrState", { RequestKey: requestKey });
}

export interface InitSbpChargeInput {
  // Our order id for this SBP recurring charge (unique per attempt, <= 50 chars).
  orderId: string;
  // Amount in kopecks for the tariff. Note: SBP has a 10 ₽ minimum per T-Bank.
  amountKopecks: number;
  description: string;
  // CustomerKey ties the charge to the rider whose account we're debiting.
  customerKey: string;
  // Where T-Bank POSTs the asynchronous result.
  notificationUrl: string;
}

// Create the payment object for a recurring SBP charge against a bound ACCOUNT
// via /Init, then /ChargeQr with the AccountToken. Per the T-Bank spec the
// parent-linked recurring SBP payment sets Recurrent=Y and DATA={"QR":"true"}.
// DATA is a nested object so it never takes part in the token (by design); the
// scalar fields are signed exactly as sent (avoids code 204). Returns a
// PaymentId used by the subsequent ChargeQr.
export async function tbankInitSbpCharge(
  cfg: TbankConfig,
  input: InitSbpChargeInput,
): Promise<TbankResponse> {
  return signedPost(cfg, "/Init", {
    Amount: input.amountKopecks,
    OrderId: input.orderId,
    Description: input.description,
    CustomerKey: input.customerKey,
    Recurrent: "Y",
    NotificationURL: input.notificationUrl,
    // Nested → excluded from the token, included in the body (like Receipt).
    DATA: { QR: "true" },
  });
}

export interface ChargeQrInput {
  // PaymentId returned by the preceding Init for this SBP charge.
  paymentId: string;
  // The stored SBP account token issued when the rider's account was bound.
  accountToken: string;
}

// Debit a bound SBP account via /ChargeQr using PaymentId + AccountToken. No
// account data beyond the opaque token is involved. On success the response
// Status is AUTHORIZED/CONFIRMED (classifyRidePayment maps those to "paid"); a
// deferred result arrives later on the NotificationURL. Signs and sends exactly
// PaymentId + AccountToken (avoids code 204).
export async function tbankChargeQr(
  cfg: TbankConfig,
  input: ChargeQrInput,
): Promise<TbankResponse> {
  return signedPost(cfg, "/ChargeQr", {
    PaymentId: input.paymentId,
    AccountToken: input.accountToken,
  });
}

// Build a compact, collision-resistant OrderId for an SBP account binding.
// Same constraints as the card generators — <= 50 chars, ASCII latin/digits/dash
// only. A distinct "TRSB" (TakeRide Sbp Binding) prefix lets logs/handlers tell
// an SBP account binding apart from a card binding at a glance.
export function generateSbpBindOrderId(): string {
  const ts = Date.now().toString(36);
  let rand = "";
  while (rand.length < 6) rand += randomInt(36).toString(36);
  return `TRSB-${ts}-${rand.slice(0, 6)}`;
}

// Extract the QR payload / deeplink from an AddAccountQr response. The acquirer
// returns it in `Data` (PAYLOAD → a link/deeplink string; IMAGE → base64), and
// some builds echo a QrCodeData/Payload field. Returns the first non-empty
// string we find so the client can render a QR and/or an "open in bank" link.
export function extractQrPayload(resp: TbankResponse): string {
  for (const v of [resp.Data, resp.QrCodeData, resp.Payload]) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

// Map a T-Bank AddAccountQr binding state/notification to our lifecycle. The
// account is "active" once the acquirer reports ACTIVE (with an AccountToken);
// it is "failed" on INACTIVE or an explicit terminal rejection; everything else
// (NEW/PROCESSING) is still in flight. Mirrors classifyCardBinding so the
// notification webhook and the state poller agree on each status.
export function classifyAccountBinding(args: {
  status?: string;
  accountToken?: string;
  success?: boolean;
}): CardBindingOutcome {
  const status = (args.status || "").trim().toUpperCase();
  if (status === "ACTIVE" || (args.accountToken && args.accountToken.length > 0)) {
    return "active";
  }
  if (args.success === false || status === "INACTIVE" || FAILED_BINDING_STATUSES.includes(status)) {
    return "failed";
  }
  return "pending";
}

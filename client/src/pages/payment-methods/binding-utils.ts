import type { PublicPaymentMethod } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";

// Live state for an in-progress SBP account binding. `payload` is the QR/
// deeplink the rider opens in their bank; `methodId` is the pending method we poll
// to detect activation. `status` drives the modal's headline (waiting → success
// / failed). Held in component state so the QR modal survives re-renders while
// the rider authorises the binding in their bank app.
export interface SbpBinding {
  methodId: number;
  payload: string;
  status: "waiting" | "active" | "failed";
  error?: string;
}

export interface PendingBindingState {
  pollable: PublicPaymentMethod[];
  timedOut: PublicPaymentMethod[];
}

export const PENDING_BINDING_TIMEOUT_MS = 3 * 60 * 1_000;

// Human sublabel + tone for a payment-method status. Shown as the small
// secondary line under the method label, matching the profile-row style.
export function statusLabel(status: string): { text: string; cls: string } {
  switch (status) {
    case "active":
      return { text: "Активна", cls: "text-green-500" };
    case "failed":
      return { text: "Ошибка привязки", cls: "text-red-500" };
    default:
      return { text: "Привязана", cls: "text-gray-400 dark:text-zinc-500" };
  }
}

export function visiblePaymentMethods(methods: PublicPaymentMethod[]): PublicPaymentMethod[] {
  return methods.filter((method) => method.status !== "pending" && method.status !== "failed");
}

// API data is normally serialized as a numeric unix-ms value by Drizzle. Keep
// the timeout guard defensive nevertheless: a date string, seconds timestamp,
// or malformed legacy value must never be mistaken for a three-minute-old bind.
function createdAtMs(value: unknown): number | null {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : NaN;
  if (Number.isFinite(numeric)) {
    // Unix seconds are still accepted from legacy/alternate serializers.
    return Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Exported for the Node-only contract tests. In particular, active methods
// must never participate in the timeout decision, regardless of their age.
export function partitionPendingBindings(
  methods: PublicPaymentMethod[],
  now: number,
): PendingBindingState {
  const pollable: PublicPaymentMethod[] = [];
  const timedOut: PublicPaymentMethod[] = [];
  for (const method of methods) {
    if (method.status !== "pending") continue;
    const createdAt = createdAtMs(method.createdAt);
    const age = createdAt === null ? null : Math.max(0, now - createdAt);
    // An invalid/unknown timestamp cannot establish a timeout. Continue
    // background reconciliation rather than presenting a false failure.
    if (age !== null && age >= PENDING_BINDING_TIMEOUT_MS) timedOut.push(method);
    else pollable.push(method);
  }
  return { pollable, timedOut };
}

export async function refreshPendingMethod(method: PublicPaymentMethod): Promise<PublicPaymentMethod | null> {
  let res: Response;
  if (method.type === "sbp" && method.requestKey) {
    res = await apiRequest("GET", `/api/payments/tbank/refresh-bind-sbp/${method.id}`);
  } else if (method.requestKey) {
    res = await apiRequest("POST", `/api/payment-methods/${method.id}/refresh`);
  } else if (method.paymentId) {
    res = await apiRequest("GET", `/api/payments/tbank/refresh-bind/${method.id}`);
  } else {
    return null;
  }
  return (await res.json()) as PublicPaymentMethod;
}

// Use the same unlink endpoint as the pre-existing trash action. `pendingOnly`
// makes the cleanup idempotent and prevents a timeout based on stale client
// data from removing a method that has just been activated by a webhook.
export async function cancelTimedOutPendingMethod(method: PublicPaymentMethod): Promise<void> {
  await apiRequest("DELETE", `/api/payment-methods/${method.id}?pendingOnly=1`);
}

// Render the stored T-Bank binding error for a failed method. Combines the
// acquirer's message/details with a parenthetical code when present; these
// fields come straight from T-Bank and carry no secret.
export function methodError(m: PublicPaymentMethod): string {
  const message = (m.lastErrorMessage || "").trim();
  const details = (m.lastErrorDetails || "").trim();
  const code = (m.lastErrorCode || "").trim();
  const base = message || details || "Банк отклонил привязку карты.";
  const extras = [
    code ? `код ${code}` : "",
    details && details !== base ? details : "",
  ].filter(Boolean).join(", ");
  return extras ? `${base} (${extras})` : base;
}

// apiRequest throws "<status>: <body>" — the add-card endpoint returns the
// acquirer's own { error, code, message, details }; cleanErrWithDetails
// surfaces the message plus a parenthetical code/details so a rider (or
// support) sees *why* the binding failed instead of a generic rejection.
// Re-exported as `cleanErr` to keep every existing import in this codebase
// unchanged (audit MEDIUM #9 dedup — see client/src/lib/api-error.ts).
export { cleanErrWithDetails as cleanErr } from "@/lib/api-error";

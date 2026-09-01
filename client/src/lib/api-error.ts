// apiRequest (see queryClient.ts) throws `Error("<status>: <body>")`. Every
// screen that shows a failed mutation as a toast/inline message needs to pull
// a human string out of that body instead of rendering raw JSON — this was
// previously copy-pasted byte-for-byte into users-admin/error-utils.ts,
// rides-admin/error-utils.ts, RentalStartModal.tsx, and (with an extra
// code/details suffix) payment-methods/binding-utils.ts. Consolidated here
// (audit MEDIUM #9) so the status-prefix-and-JSON-body parsing lives in one
// place; the two exports keep each call site's existing behavior unchanged.
//
// Deliberately dependency-free (no React/query imports) so it stays trivial
// to unit test in isolation.

interface ParsedApiErrorBody {
  error?: unknown;
  code?: unknown;
  details?: unknown;
}

function parseApiErrorBody(e: Error): { body: string; parsed: ParsedApiErrorBody | null } {
  const m = e.message.match(/^\d+:\s*([\s\S]*)$/);
  const body = m ? m[1] : e.message;
  try {
    const parsed = JSON.parse(body);
    return { body, parsed: parsed && typeof parsed === "object" ? parsed : null };
  } catch {
    // body wasn't JSON; fall through and surface it as-is.
    return { body, parsed: null };
  }
}

// Basic variant: surface the acquirer/API's own `error` message, or the raw
// body text when it isn't JSON. Used by UsersPage, RidesAdminPage and
// RentalStartModal.
export function cleanErr(e: Error): string {
  const { body, parsed } = parseApiErrorBody(e);
  const message = parsed?.error;
  return typeof message === "string" && message ? message : body;
}

// Extended variant: same base parsing, plus a parenthetical "(код <code>,
// <details>)" suffix when the acquirer supplied them. Used by
// PaymentMethodsPage for T-Bank card/SBP binding failures, where the code
// and details are diagnostic value for the rider or support, not secrets.
export function cleanErrWithDetails(e: Error): string {
  const { body, parsed } = parseApiErrorBody(e);
  const message = parsed?.error;
  if (typeof message !== "string" || !message) return body;
  const code = typeof parsed?.code === "string" ? parsed.code : "";
  const details = typeof parsed?.details === "string" ? parsed.details : "";
  const extra = code ? `код ${code}` : "";
  const detail = details && details !== message ? details : "";
  const suffix = [extra, detail].filter(Boolean).join(", ");
  return suffix ? `${message} (${suffix})` : message;
}

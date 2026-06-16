// Pull a human-readable message out of an error thrown by apiRequest. The thrown
// Error message is `"<status>: <body>"` where body is usually the JSON our API
// returns (`{"error":"…"}`). Without this, the UI would render the raw JSON
// object text (e.g. `{"error":"Не удалось отправить SMS…"}`) to the rider.
//
// Kept dependency-free (no React/query imports) so it can be unit-smoke-tested
// directly with tsx.
export function errorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // Strip the leading "<status>: " prefix added by throwIfResNotOk.
  const body = raw.replace(/^\d+:\s*/, "").trim();
  if (!body) return fallback;
  // The body is typically JSON like {"error":"…"} — surface the message field.
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      const msg = parsed?.error ?? parsed?.message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
      return fallback;
    } catch {
      return fallback;
    }
  }
  return body;
}

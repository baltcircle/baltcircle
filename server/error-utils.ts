// Extracts a human-readable message from a caught value of unknown type
// (network failures, thrown non-Error values, promise rejections from
// third-party SDKs, etc.). Replaces the `catch (err: any) { ... err?.message
// ?? fallback ... }` pattern used throughout the payments/auth hot paths —
// `: any` silences the type checker on every subsequent property access off
// `err`, not just `.message` (audit MEDIUM #11).
export function errMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err) return err;
  return undefined;
}

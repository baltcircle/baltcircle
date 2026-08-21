import type { Bike } from "@shared/schema";

// Extract a bike code from raw QR text. Accepts a plain id ("BC-001") or a URL
// that carries the id in the path — both the clean ".../bike/BC-001" and the
// legacy hash ".../#/bike/BC-001" forms — or a query param (?bike=BC-001 /
// ?id=BC-001). Returns an upper-cased code or null.
export function extractBikeCode(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const codePattern = /BC-?\d{1,5}/i;

  // Try to parse as a URL first (covers path + query param cases).
  try {
    const url = new URL(text);
    const fromQuery =
      url.searchParams.get("bike") ?? url.searchParams.get("id") ?? "";
    if (fromQuery) {
      const m = fromQuery.match(codePattern);
      if (m) return normalizeCode(m[0]);
    }
    // Path / hash may hold ".../bike/BC-001".
    const m = `${url.pathname}${url.hash}`.match(codePattern);
    if (m) return normalizeCode(m[0]);
  } catch {
    // Not a URL — fall through to plain matching.
  }

  const m = text.match(codePattern);
  if (m) return normalizeCode(m[0]);
  return null;
}

// Canonicalize to the "BC-001" shape the bike ids use.
export function normalizeCode(raw: string): string {
  const upper = raw.toUpperCase().replace(/\s+/g, "");
  const digits = upper.replace(/^BC-?/, "");
  return `BC-${digits}`;
}

/**
 * Resolves any raw scanned/typed QR text to a bike, trying in order:
 *  1. The normal "BC-XXX" bike-code pattern (camera decode, manual entry, or
 *     embedded in a URL) — matched against `bikes[].id`.
 *  2. A manufacturer-printed lock QR whose raw content doesn't look like a
 *     bike code at all (e.g. a bare numeric serial/activation code) —
 *     matched verbatim against `bikes[].externalQrCode`. This is how a
 *     physical lock's own QR sticker (never otherwise used by the app) can
 *     start a real rental on the exact bike it's fitted to — see
 *     `bikes.isTestBike` / `rides.isTest` for how that ride gets tagged.
 * Returns the matched bike, or an error message key describing why nothing
 * matched (bike not found vs. found but not currently rentable).
 */
export function resolveScannedCode(
  raw: string,
  bikes: Bike[],
): { bike: Bike } | { error: "not-found" | "not-available" } {
  const trimmed = raw.trim();
  const bikeCode = extractBikeCode(trimmed);

  const match = bikeCode
    ? bikes.find((b) => b.id.toUpperCase() === bikeCode)
    : bikes.find((b) => !!b.externalQrCode && b.externalQrCode === trimmed);

  if (!match) return { error: "not-found" };
  if (match.status !== "available") return { error: "not-available" };
  return { bike: match };
}

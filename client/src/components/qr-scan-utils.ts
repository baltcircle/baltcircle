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
 * Resolves any raw scanned/typed QR text to a bike via the normal "BC-XXX"
 * bike-code pattern (camera decode, manual entry, or embedded in a URL) —
 * matched against `bikes[].id`. The manufacturer-printed lock QR fallback
 * (bikes[].externalQrCode) has been removed along with that field.
 * Returns the matched bike, or an error message key describing why nothing
 * matched (bike not found vs. found but not currently rentable).
 */
export function resolveScannedCode(
  raw: string,
  bikes: Bike[],
): { bike: Bike } | { error: "not-found" | "not-available" } {
  const trimmed = raw.trim();
  const bikeCode = extractBikeCode(trimmed);

  const match = bikeCode ? bikes.find((b) => b.id.toUpperCase() === bikeCode) : undefined;

  if (!match) return { error: "not-found" };
  if (match.status !== "available") return { error: "not-available" };
  return { bike: match };
}

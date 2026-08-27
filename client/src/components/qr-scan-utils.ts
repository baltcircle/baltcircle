import type { Bike } from "@shared/schema";

// Cyrillic letters that are visually identical to the Latin "B"/"C" used in
// bike codes (В=U+0412/в=U+0432 look like B; С=U+0421/с=U+0441 look like C).
// A rider typing a code manually (no camera) on a Cyrillic keyboard layout
// can easily produce "ВС-014" instead of "BC-014" — this swaps those specific
// homoglyphs back to Latin before pattern matching, so both layouts resolve
// to the same bike. Deliberately narrow (just B/C, not a full Cyrillic→Latin
// transliteration) to avoid mangling anything else typed into the field.
const CYRILLIC_BC_HOMOGLYPHS: Record<string, string> = {
  "\u0412": "B", "\u0432": "B", // В / в
  "\u0421": "C", "\u0441": "C", // С / с
};

function deCyrillicizeBikeCode(text: string): string {
  return text.replace(/[\u0412\u0432\u0421\u0441]/g, (ch) => CYRILLIC_BC_HOMOGLYPHS[ch] ?? ch);
}

// Extract a bike code from raw QR text. Accepts a plain id ("BC-001") or a URL
// that carries the id in the path — both the clean ".../bike/BC-001" and the
// legacy hash ".../#/bike/BC-001" forms — or a query param (?bike=BC-001 /
// ?id=BC-001). Also accepts "BC" typed with Cyrillic В/С (same glyph shape as
// Latin B/C) so manual entry works regardless of keyboard layout. Returns an
// upper-cased code or null.
export function extractBikeCode(raw: string): string | null {
  const text = deCyrillicizeBikeCode(raw.trim());
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

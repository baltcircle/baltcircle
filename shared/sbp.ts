// Bank of the СБП member list, as served to the client for the account-binding
// picker. Deliberately narrower than T-Bank's raw item: the rider only needs a
// stable id to pass back, a name to tap, and an optional logo.
export interface SbpBank {
  // T-Bank's BankId/MemberId — opaque, echoed back verbatim in AddAccountQr.
  id: string;
  name: string;
  logoUrl?: string;
}

// The picker sends the device class because T-Bank returns a different member
// list per device: a desktop browser cannot open a bank deeplink, so that list
// is the QR-oriented one.
export type SbpDeviceType = "mobile" | "desktop";

// Ids are echoed back to the acquirer, so accept only the opaque-token shape
// both T-Bank and НСПК use. Anything else is a malformed or hostile value and
// must never reach a signed request.
const BANK_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function isValidSbpBankId(value: unknown): value is string {
  return typeof value === "string" && BANK_ID_RE.test(value);
}

// Only https logos are rendered. A bank logo is a third-party URL we do not
// control; http would downgrade the page and a data:/javascript: URL has no
// business in an <img src> we build from an upstream response.
export function isSafeBankLogoUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Ranking for the picker. T-Bank returns the member list in an order that is
// not useful to a rider (roughly registry order), and the long tail is ~200
// banks. Surface the handful that cover most of the market first, keep the
// acquirer's order within each group.
//
// Matched against the START of the normalized name, not anywhere inside it:
// a substring match promotes unrelated banks that merely contain the word, and
// \b cannot be used as a guard because JavaScript defines word boundaries over
// [A-Za-z0-9_] only — it never fires next to Cyrillic.
const POPULAR_BANK_PATTERNS: RegExp[] = [
  /^(т-?банк|тинькофф|tinkoff|tbank)/,
  /^(сбер|sber)/,
  /^(альфа-?банк|alfa)/,
  /^(втб|vtb)/,
  /^газпромбанк/,
  /^райффайзен/,
  /^(озон|ozon)/,
  /^(яндекс|yandex)/,
];

// Names arrive with the legal form and quotes attached («ПАО Сбербанк»),
// which would defeat a start-anchored match.
function normalizeBankName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[«»"'“”]/g, "")
    .replace(/^(пао|ао|оао|зао|ооо|акб|кб|банк)\s+/g, "")
    .trim();
}

export function sortSbpBanks(banks: SbpBank[]): SbpBank[] {
  const rank = (bank: SbpBank): number => {
    const name = normalizeBankName(bank.name);
    const index = POPULAR_BANK_PATTERNS.findIndex((re) => re.test(name));
    return index === -1 ? POPULAR_BANK_PATTERNS.length : index;
  };
  return banks
    .map((bank, index) => ({ bank, index, rank: rank(bank) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
    .map((entry) => entry.bank);
}

// Case- and layout-tolerant substring match for the picker's search box.
export function filterSbpBanks(banks: SbpBank[], query: string): SbpBank[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return banks;
  return banks.filter((bank) => bank.name.toLowerCase().includes(needle));
}

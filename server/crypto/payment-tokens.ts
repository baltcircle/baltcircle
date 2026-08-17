// Encryption for T-Bank recurring-charge tokens (RebillId / SBP AccountToken)
// at rest — audit HIGH #9. These are not card numbers, but they ARE bearer
// tokens: whoever holds one can make the acquirer pull money from the
// rider's card/account on our behalf. A plaintext DB dump (backup leak, SSRF,
// misconfigured replica) previously handed an attacker a working recurring
// charge for every linked rider.
//
// Design:
//   - AES-256-GCM, random 96-bit IV per value, authenticated (tamper-evident:
//     decryption fails closed if the ciphertext was altered).
//   - Stored as "v1:<base64(iv || tag || ciphertext)>" so the format can be
//     versioned if the scheme ever changes.
//   - Legacy plaintext rows (written before this migration, no "v1:" prefix)
//     still decrypt as a passthrough so existing bindings keep working; they
//     get re-encrypted the next time they're written (updatePaymentMethod)
//     and once via the startup backfill in server/db/bootstrap.ts.
//   - Equality lookups (e.g. "is this RebillId already linked to another
//     row?") can't run against ciphertext — a random IV means the same
//     plaintext never encrypts to the same bytes twice. A separate
//     deterministic HMAC-SHA256 "blind index" column is looked up instead;
//     the encrypted value itself is only ever decrypted for the one row a
//     caller already has in hand.
//
// One 32-byte master secret is enough to configure: the AES key and the HMAC
// index key are both derived from it via HMAC-with-a-context-label, so a key
// compromise scoped to one purpose doesn't trivially hand over the other.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { logger } from "../logger";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // NIST-recommended nonce length for GCM
const TAG_LEN = 16;
const PREFIX = "v1:";

let warnedInsecureDevKey = false;

function masterSecret(): string {
  const configured = process.env.PAYMENT_TOKEN_KEY;
  if (configured && configured.trim()) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PAYMENT_TOKEN_KEY is required in production to encrypt stored payment tokens (RebillId/AccountToken).",
    );
  }
  if (!warnedInsecureDevKey) {
    warnedInsecureDevKey = true;
    logger.warn(
      "PAYMENT_TOKEN_KEY is not set — using an insecure, fixed dev-only key for payment token encryption. " +
        "Set PAYMENT_TOKEN_KEY before deploying to production.",
    );
  }
  return "baltcircle-dev-insecure-payment-token-key";
}

function deriveKey(purpose: "enc" | "idx"): Buffer {
  return createHmac("sha256", masterSecret()).update(purpose).digest();
}

// Encrypts a non-empty plaintext token. Callers should never pass "" — treat
// empty/absent tokens as null and skip encryption entirely (see storage.ts).
export function encryptToken(plain: string): string {
  const key = deriveKey("enc");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

// Returns null for null/empty/undefined input. Legacy plaintext values (no
// "v1:" prefix — written before this migration) pass through unchanged
// rather than throwing, so old bindings don't break until they're naturally
// rewritten. A genuinely corrupt/tampered "v1:" value throws (fail closed) —
// callers must not silently treat a tampered token as absent.
export function decryptToken(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const key = deriveKey("enc");
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// Deterministic blind index for exact-match lookups (e.g. card/account
// dedup) without decrypting every candidate row. HMAC (keyed) rather than a
// bare hash so it can't be brute-forced or rainbow-tabled offline by anyone
// without the key, unlike sha256(rebillId) alone.
export function hashTokenForLookup(plain: string): string {
  return createHmac("sha256", deriveKey("idx")).update(plain).digest("hex");
}

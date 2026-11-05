// Smoke test for the T-Bank token (signature) generation.
//
// Verifies the SHA-256 token algorithm against a worked, NON-SECRET example so
// a regression in the signing logic is caught without needing real credentials.
// The example mirrors the T-Kassa docs: root-level scalar params + Password,
// sorted by key, values concatenated, SHA-256 hex.
//
// Run with:  npx tsx script/smoke-tbank-token.ts

import { computeToken, verifyNotificationToken } from "../server/tbank";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

// --- Worked example from the T-Kassa documentation (non-secret sample) ---
// Params (root level), Password = "usaf8fw8f9wf8w9f8w9f8":
const params = {
  TerminalKey: "MerchantTerminalKey",
  Amount: 19200,
  OrderId: "21090",
  Description: "Подарок на день рождения",
};
const password = "usaf8fw8f9wf8w9f8w9f8";

// Fixed non-secret test vector, independently checked with Python hashlib and Node crypto.
// SHA-256 input: Amount + Description + OrderId + Password + TerminalKey.
// This is a bank signature fixture, not a password-storage hash.
const expected = "a0a05dfbcb32eff68af397cffa40755d02525f8d9c9ce19f67488314b25d708b";

const token = computeToken(params, password);
assert(token === expected, "computeToken matches the manually-sorted SHA-256 digest");

// Nested objects (Receipt/DATA) and any existing Token must be excluded.
const withNested = {
  ...params,
  Token: "should-be-ignored",
  Receipt: { Items: [{ Name: "x", Price: 100 }] },
  DATA: { Phone: "+70000000000" },
};
assert(
  computeToken(withNested, password) === expected,
  "computeToken ignores nested objects and any existing Token field",
);

// Notification verification: a body carrying a correct Token verifies; a wrong
// one is rejected.
const notif = {
  TerminalKey: "MerchantTerminalKey",
  OrderId: "21090",
  Success: true,
  Status: "CONFIRMED",
  PaymentId: "13660",
  Amount: 19200,
};
const goodToken = computeToken(notif, password);
assert(
  verifyNotificationToken({ ...notif, Token: goodToken }, password),
  "verifyNotificationToken accepts a correctly-signed notification",
);
assert(
  !verifyNotificationToken({ ...notif, Token: "deadbeef" }, password),
  "verifyNotificationToken rejects a tampered token",
);
assert(
  !verifyNotificationToken({ ...notif }, password),
  "verifyNotificationToken rejects a missing token",
);

// --- Password containing '$' is signed verbatim (no interpolation in code) ---
// The signing logic treats the password as opaque bytes; a `$` is just another
// character. This documents that any lost `$` is a delivery (env/compose) issue,
// not a code issue. Uses an obvious non-secret value.
const dollarParams = { TerminalKey: "T", CustomerKey: "u-1", CheckType: "3DS" };
const dollarPassword = "$abc$def";
// Fixed SHA-256 of CheckType + CustomerKey + Password + TerminalKey.
const dollarExpected = "1929b10d211e9e15131814d6d5dd020d34492e764ea76c8874dd3b42962a3e91";
assert(
  computeToken(dollarParams, dollarPassword) === dollarExpected,
  "computeToken signs a $-containing password verbatim",
);
assert(
  computeToken(dollarParams, dollarPassword) !== computeToken(dollarParams, "abcdef"),
  "dropping the $ chars yields a different token (delivery must preserve $)",
);

// --- null/undefined params do not participate in the token ---
// computeToken drops undefined/null scalars, so absent optional fields must not
// change the digest. (Empty-string pruning is handled separately by signedPost
// before signing, keeping the signed set equal to the sent set.)
const base = { TerminalKey: "T", CustomerKey: "u-1", CheckType: "3DS" };
const withEmpties = { ...base, IP: undefined, ResidentState: null };
assert(
  computeToken(withEmpties as any, "pw") === computeToken(base, "pw"),
  "computeToken ignores undefined/null params",
);

if (!process.exitCode) console.log("\nAll T-Bank token smoke checks passed.");

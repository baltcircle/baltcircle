// Smoke test for the T-Bank token (signature) generation.
//
// Verifies the SHA-256 token algorithm against a worked, NON-SECRET example so
// a regression in the signing logic is caught without needing real credentials.
// The example mirrors the T-Kassa docs: root-level scalar params + Password,
// sorted by key, values concatenated, SHA-256 hex.
//
// Run with:  npx tsx script/smoke-tbank-token.ts

import { createHash } from "node:crypto";
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

// Independently recompute the expected digest the way the docs describe:
// sorted pairs: Amount, Description, OrderId, Password, TerminalKey
const expectedConcat =
  "19200" +
  "Подарок на день рождения" +
  "21090" +
  password +
  "MerchantTerminalKey";
const expected = createHash("sha256").update(expectedConcat, "utf8").digest("hex");

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
const dollarExpected = createHash("sha256")
  .update("3DS" + "u-1" + dollarPassword + "T", "utf8") // sorted: CheckType, CustomerKey, Password, TerminalKey
  .digest("hex");
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

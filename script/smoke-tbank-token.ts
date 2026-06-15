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

if (!process.exitCode) console.log("\nAll T-Bank token smoke checks passed.");

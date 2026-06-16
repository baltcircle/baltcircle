// Smoke test for the GetAddCardState poller and the card-binding lifecycle
// classifier — the recovery path that resolves a method stuck on "pending"
// when the notification webhook never arrived.
//
// Verifies — without any real credentials — that:
//   - tbankGetAddCardState posts EXACTLY TerminalKey + RequestKey + Token to
//     /GetAddCardState and signs the final payload (sending extra fields would
//     break the token -> code 204, the same trap as AddCard);
//   - classifyCardBinding maps acquirer Status/CardId onto our
//     active/failed/pending lifecycle correctly.
//
// fetch is stubbed so nothing leaves the process; the dummy terminal key and
// password are obvious non-secrets used only to exercise the signing path.
//
// Run with:  npx tsx script/smoke-tbank-addcard-state.ts

import {
  classifyCardBinding,
  computeToken,
  tbankGetAddCardState,
  type TbankConfig,
} from "../server/tbank";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

// --- classifyCardBinding lifecycle mapping ---
assert(classifyCardBinding({ cardId: "card-1" }) === "active", "a CardId means active");
assert(classifyCardBinding({ status: "COMPLETED" }) === "active", "COMPLETED status means active");
assert(classifyCardBinding({ status: "AUTHORIZED" }) === "active", "AUTHORIZED status means active");
assert(classifyCardBinding({ status: "REJECTED" }) === "failed", "REJECTED status means failed");
assert(
  classifyCardBinding({ status: "DEADLINE_EXPIRED" }) === "failed",
  "DEADLINE_EXPIRED status means failed",
);
assert(classifyCardBinding({ status: "AUTH_FAIL" }) === "failed", "AUTH_FAIL status means failed");
assert(classifyCardBinding({ status: "rejected" }) === "failed", "status match is case-insensitive");
assert(classifyCardBinding({ status: "NEW" }) === "pending", "NEW status stays pending");
assert(classifyCardBinding({ status: "FORM_SHOWED" }) === "pending", "FORM_SHOWED stays pending");
assert(classifyCardBinding({}) === "pending", "no status / no cardId stays pending");

// --- GetAddCardState payload shape (fetch stubbed) ---
const cfg: TbankConfig = {
  terminalKey: "DummyTerminalKey",
  password: "dummy-password",
  apiBase: "https://example.test/v2",
  publicAppUrl: "https://app.test",
  addCardCheckType: "3DS",
};

let captured: { url: string; body: Record<string, unknown> } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  captured = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
  return {
    ok: true,
    status: 200,
    json: async () => ({ Success: true, Status: "COMPLETED", CardId: "card-42", RebillId: "rb-7" }),
  } as unknown as Response;
}) as typeof fetch;

try {
  const resp = await tbankGetAddCardState(cfg, "rk-123");
  assert(resp.Success === true, "tbankGetAddCardState returns the parsed response");
  assert(resp.CardId === "card-42", "response carries CardId");

  const c = captured as { url: string; body: Record<string, unknown> } | null;
  assert(!!c, "GetAddCardState issued an HTTP request");
  const body = c!.body;

  assert(c!.url === "https://example.test/v2/GetAddCardState", "posts to the /GetAddCardState path");
  assert(body.TerminalKey === "DummyTerminalKey", "payload carries TerminalKey");
  assert(body.RequestKey === "rk-123", "payload carries RequestKey");

  // Sends exactly three root-level keys: the two signed fields plus Token.
  assert(
    Object.keys(body).sort().join(",") === "RequestKey,TerminalKey,Token",
    "payload contains exactly TerminalKey, RequestKey, Token",
  );

  // Token must match a recomputation over the EXACT final payload (minus Token).
  const { Token, ...signable } = body as Record<string, unknown> & { Token?: string };
  assert(typeof Token === "string" && Token.length === 64, "payload carries a 64-hex Token");
  assert(
    computeToken(signable, cfg.password) === Token,
    "payload Token matches a recomputed SHA-256 signature over the final payload",
  );

  // The classifier agrees the stubbed COMPLETED+CardId response is active.
  assert(
    classifyCardBinding({ status: String(resp.Status), cardId: String(resp.CardId) }) === "active",
    "GetAddCardState COMPLETED+CardId classifies as active",
  );
} finally {
  globalThis.fetch = realFetch;
}

if (!process.exitCode) console.log("\nAll T-Bank GetAddCardState smoke checks passed.");

// Smoke test for the in-place otp_requests migration (SMS delivery diagnostics)
// and the storage methods that persist/read the provider delivery status.
//
// Reproduces a legacy DB whose otp_requests table predates the provider columns
// (provider, provider_message_id, provider_status, provider_error,
// provider_checked_at). The migration must add them in place while preserving
// any pending OTP row, and recordOtpSend/getLastOtpSend/updateOtpProviderStatus
// must round-trip the diagnostics.
//
// Run with:  npx tsx script/smoke-otp-status-migration.ts

import { rmSync, existsSync } from "node:fs";
import Database from "better-sqlite3";

const DB_PATH = "/tmp/bc-smoke-otp-status-migration.db";

for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (existsSync(f)) rmSync(f);
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

const PHONE = "+79991234567";

async function main() {
  // ---- 1. Seed a legacy otp_requests table (pre-provider columns) ----
  const seed = new Database(DB_PATH);
  seed.exec(`
    CREATE TABLE otp_requests (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
  `);
  // A pre-existing pending row that must survive the migration untouched.
  seed.prepare(
    "INSERT INTO otp_requests (phone, name, code_hash, expires_at, attempts, last_sent_at, consumed) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(PHONE, "Legacy Rider", "deadbeef", Date.now() + 300000, 0, Date.now(), 0);

  const legacyCols = (seed.prepare("PRAGMA table_info(otp_requests)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert(!legacyCols.includes("provider"), "legacy table starts WITHOUT a provider column");
  seed.close();

  // ---- 2. Import storage against the legacy DB (runs the migration) ----
  process.env.DATABASE_PATH = DB_PATH;
  const { storage } = await import("../server/storage");

  // ---- 3. The migration added the provider columns ----
  const check = new Database(DB_PATH, { readonly: true });
  const cols = (check.prepare("PRAGMA table_info(otp_requests)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  check.close();
  for (const col of [
    "provider",
    "provider_message_id",
    "provider_status",
    "provider_error",
    "provider_checked_at",
  ]) {
    assert(cols.includes(col), `migration added the "${col}" column`);
  }

  // The pre-existing legacy row survived the ALTERs.
  const legacy = storage.getLastOtpSend(PHONE);
  assert(!!legacy, "pre-existing pending OTP row is preserved");
  assert(legacy!.name === "Legacy Rider", "legacy row keeps its original name");
  assert(legacy!.provider == null, "legacy row has a null provider before any send is recorded");

  // ---- 4. recordOtpSend persists provider diagnostics ----
  storage.recordOtpSend({
    phone: PHONE,
    provider: "sigmasms",
    providerMessageId: "abc-123",
    providerStatus: "queued",
  });
  const afterSend = storage.getLastOtpSend(PHONE);
  assert(afterSend!.provider === "sigmasms", "recordOtpSend persists the provider");
  assert(afterSend!.providerMessageId === "abc-123", "recordOtpSend persists the sending id");
  assert(afterSend!.providerStatus === "queued", "recordOtpSend persists the accepted status");
  assert(typeof afterSend!.providerCheckedAt === "number", "recordOtpSend stamps providerCheckedAt");

  // ---- 5. updateOtpProviderStatus refreshes the status without touching the id ----
  storage.updateOtpProviderStatus({ phone: PHONE, providerStatus: "delivered" });
  const afterRefresh = storage.getLastOtpSend(PHONE);
  assert(afterRefresh!.providerStatus === "delivered", "updateOtpProviderStatus refreshes the status");
  assert(afterRefresh!.providerMessageId === "abc-123", "status refresh leaves the sending id intact");
  assert(afterRefresh!.codeHash === "deadbeef", "status refresh never touches the code hash");

  if (!process.exitCode) console.log("\nAll otp_requests migration smoke checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });

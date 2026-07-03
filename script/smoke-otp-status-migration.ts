// Smoke test for the otp_requests provider-diagnostics columns on Postgres
// and the storage methods that persist/read the provider delivery status.
//
// On Postgres the schema is created in full by bootstrap (no in-place legacy
// migration is needed). This test therefore:
//   1. Boots bootstrap against a fresh throwaway Postgres DB.
//   2. Asserts the otp_requests table already HAS every provider column.
//   3. Seeds a pending OTP row, then verifies recordOtpSend / getLastOtpSend /
//      updateOtpProviderStatus round-trip the diagnostics.
//
// Run with:  npx tsx script/smoke-otp-status-migration.ts

import { createTestDb, dropTestDb, openTestDb } from "./smoke-pg";

const NAME = "otp-status-migration";

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
  // ---- 1. Fresh Postgres DB, boot storage (runs bootstrap) ----
  const { url } = await createTestDb(NAME);
  process.env.DATABASE_URL = url;
  const { storage, bootstrapReady, pool } = await import("../server/storage");
  await bootstrapReady;

  // ---- 2. The provider columns exist from the start ----
  const check = await openTestDb(url);
  const cols = await check.columns("otp_requests");
  await check.close();
  for (const col of [
    "provider",
    "provider_message_id",
    "provider_status",
    "provider_error",
    "provider_checked_at",
  ]) {
    assert(cols.includes(col), `otp_requests has the "${col}" column`);
  }

  // ---- 3. Seed a pending OTP row directly ----
  await pool.query(
    `INSERT INTO otp_requests (phone, name, code_hash, expires_at, attempts, last_sent_at, consumed)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [PHONE, "Legacy Rider", "deadbeef", Date.now() + 300000, 0, Date.now(), false],
  );

  const seeded = await storage.getLastOtpSend(PHONE);
  assert(!!seeded, "pending OTP row is readable");
  assert(seeded!.name === "Legacy Rider", "row keeps its original name");
  assert(seeded!.provider == null, "row has a null provider before any send is recorded");

  // ---- 4. recordOtpSend persists provider diagnostics ----
  await storage.recordOtpSend({
    phone: PHONE,
    provider: "sigmasms",
    providerMessageId: "abc-123",
    providerStatus: "queued",
  });
  const afterSend = await storage.getLastOtpSend(PHONE);
  assert(afterSend!.provider === "sigmasms", "recordOtpSend persists the provider");
  assert(afterSend!.providerMessageId === "abc-123", "recordOtpSend persists the sending id");
  assert(afterSend!.providerStatus === "queued", "recordOtpSend persists the accepted status");
  assert(typeof afterSend!.providerCheckedAt === "number", "recordOtpSend stamps providerCheckedAt");

  // ---- 5. updateOtpProviderStatus refreshes the status without touching the id ----
  await storage.updateOtpProviderStatus({ phone: PHONE, providerStatus: "delivered" });
  const afterRefresh = await storage.getLastOtpSend(PHONE);
  assert(afterRefresh!.providerStatus === "delivered", "updateOtpProviderStatus refreshes the status");
  assert(afterRefresh!.providerMessageId === "abc-123", "status refresh leaves the sending id intact");
  assert(afterRefresh!.codeHash === "deadbeef", "status refresh never touches the code hash");

  if (!process.exitCode) console.log("\nAll otp_requests provider-diagnostics smoke checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const { pool } = await import("../server/storage");
      await pool.end();
    } catch {
      // ignore
    }
    await dropTestDb(NAME);
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });

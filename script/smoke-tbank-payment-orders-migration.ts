// Smoke test for the in-place payment_orders migration (ride pay-then-start).
//
// Reproduces the production bug: a legacy DB whose payment_orders table predates
// the T-Bank Init metadata columns (no payment_id, payment_url, ride_id, error
// fields, ...). Inserting a ride payment order on such a DB failed with
//   "table payment_orders has no column named payment_id".
//
// The test:
//   1. Pre-creates a throwaway DB with a LEGACY payment_orders table that has
//      only the original core columns (no payment_id et al.).
//   2. Imports the storage module (which runs migratePaymentOrdersTable() on
//      load) against that DB via DATABASE_PATH.
//   3. Asserts the migration added the missing columns and that creating +
//      updating a ride payment order (the failing production path) now works,
//      while the pre-existing legacy row is preserved.
//
// Run with:  npx tsx script/smoke-tbank-payment-orders-migration.ts

import { rmSync, existsSync } from "node:fs";
import Database from "better-sqlite3";

const DB_PATH = "/tmp/bc-smoke-payment-orders-migration.db";

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

async function main() {
  // ---- 1. Seed a legacy payment_orders table (pre-Init-metadata columns) ----
  const seed = new Database(DB_PATH);
  seed.exec(`
    CREATE TABLE payment_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      bike_id TEXT NOT NULL,
      tariff_id TEXT NOT NULL,
      amount_kopecks INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // A pre-existing legacy row that must survive the migration untouched.
  seed.prepare(
    "INSERT INTO payment_orders (order_id, user_id, bike_id, tariff_id, amount_kopecks, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("LEGACY-ORDER-1", "legacy-user", "BC-001", "h1", 12000, Date.now());

  const legacyCols = (seed.prepare("PRAGMA table_info(payment_orders)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  assert(!legacyCols.includes("payment_id"), "legacy table starts WITHOUT a payment_id column");
  seed.close();

  // ---- 2. Import storage against the legacy DB (runs the migration) ----
  process.env.DATABASE_PATH = DB_PATH;
  const { storage } = await import("../server/storage");

  // ---- 3. The migration added the missing columns ----
  const check = new Database(DB_PATH, { readonly: true });
  const cols = (check.prepare("PRAGMA table_info(payment_orders)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  check.close();
  for (const col of [
    "payment_id",
    "payment_url",
    "status",
    "ride_id",
    "last_error_code",
    "last_error_message",
    "last_error_details",
    "updated_at",
  ]) {
    assert(cols.includes(col), `migration added the "${col}" column`);
  }

  // The pre-existing legacy row survived the ALTERs.
  const legacy = storage.getRidePaymentOrder("LEGACY-ORDER-1");
  assert(!!legacy, "pre-existing legacy payment order row is preserved");
  assert(legacy!.userId === "legacy-user", "legacy row keeps its original user_id");

  // ---- 4. The failing production path now succeeds ----
  const order = storage.createRidePaymentOrder({
    orderId: "SMOKE-ORDER-1",
    userId: "smoke-user",
    bikeId: "BC-002",
    tariffId: "h2",
    amountKopecks: 24000,
  });
  assert(!!order && order.orderId === "SMOKE-ORDER-1", "createRidePaymentOrder inserts a pending order");
  assert(order.status === "pending", "new order defaults to status=pending");

  // This is the exact write that threw "no column named payment_id" in prod.
  const updated = storage.updateRidePaymentOrder(order.id, {
    paymentId: "999888777",
    paymentUrl: "https://securepay.tinkoff.ru/abc",
  });
  assert(updated?.paymentId === "999888777", "updateRidePaymentOrder persists payment_id");
  assert(updated?.paymentUrl === "https://securepay.tinkoff.ru/abc", "updateRidePaymentOrder persists payment_url");

  if (!process.exitCode) console.log("\nAll payment_orders migration smoke checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });

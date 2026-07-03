// Smoke test for the payment_orders T-Bank Init metadata columns on Postgres
// (ride pay-then-start) and the storage methods that create/update ride orders.
//
// On Postgres the schema is created in full by bootstrap (no in-place legacy
// migration is needed). This test therefore:
//   1. Boots bootstrap against a fresh throwaway Postgres DB.
//   2. Asserts the payment_orders table already HAS every Init-metadata column.
//   3. Verifies the previously failing production path (create + update a ride
//      payment order, plus a saved-card order) now works end to end.
//
// Run with:  npx tsx script/smoke-tbank-payment-orders-migration.ts

import { createTestDb, dropTestDb, openTestDb } from "./smoke-pg";

const NAME = "tbank-payment-orders-migration";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  // ---- 1. Fresh Postgres DB, boot storage (runs bootstrap) ----
  const { url } = await createTestDb(NAME);
  process.env.DATABASE_URL = url;
  const { storage, bootstrapReady, pool } = await import("../server/storage");
  await bootstrapReady;

  // ---- 2. The Init-metadata columns exist from the start ----
  const check = await openTestDb(url);
  const cols = await check.columns("payment_orders");
  await check.close();
  for (const col of [
    "payment_id",
    "payment_url",
    "source",
    "payment_method_id",
    "rebill_id",
    "status",
    "ride_id",
    "last_error_code",
    "last_error_message",
    "last_error_details",
    "updated_at",
  ]) {
    assert(cols.includes(col), `payment_orders has the "${col}" column`);
  }

  // ---- 3. Seed a pre-existing legacy row and confirm it reads back ----
  await pool.query(
    `INSERT INTO payment_orders (order_id, user_id, bike_id, tariff_id, amount_kopecks, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ["LEGACY-ORDER-1", "legacy-user", "BC-001", "h1", 12000, Date.now()],
  );
  const legacy = await storage.getRidePaymentOrder("LEGACY-ORDER-1");
  assert(!!legacy, "pre-existing legacy payment order row is preserved");
  assert(legacy!.userId === "legacy-user", "legacy row keeps its original user_id");

  // ---- 4. The failing production path now succeeds ----
  const order = await storage.createRidePaymentOrder({
    orderId: "SMOKE-ORDER-1",
    userId: "smoke-user",
    bikeId: "BC-002",
    tariffId: "h2",
    amountKopecks: 24000,
  });
  assert(!!order && order.orderId === "SMOKE-ORDER-1", "createRidePaymentOrder inserts a pending order");
  assert(order.status === "pending", "new order defaults to status=pending");

  // This is the exact write that threw "no column named payment_id" in prod.
  const updated = await storage.updateRidePaymentOrder(order.id, {
    paymentId: "999888777",
    paymentUrl: "https://securepay.tinkoff.ru/abc",
  });
  assert(updated?.paymentId === "999888777", "updateRidePaymentOrder persists payment_id");
  assert(updated?.paymentUrl === "https://securepay.tinkoff.ru/abc", "updateRidePaymentOrder persists payment_url");

  // ---- 5. A saved-card order records its source + RebillId reference ----
  const savedOrder = await storage.createRidePaymentOrder({
    orderId: "SMOKE-ORDER-SAVED-1",
    userId: "smoke-user",
    bikeId: "BC-003",
    tariffId: "h3",
    amountKopecks: 80000,
    source: "saved_card",
    paymentMethodId: 42,
    rebillId: "555000",
  });
  assert(savedOrder.source === "saved_card", "saved-card order records source=saved_card");
  assert(savedOrder.paymentMethodId === 42, "saved-card order records the payment_method_id");
  assert(savedOrder.rebillId === "555000", "saved-card order records the rebill_id reference");
  // The hosted path keeps defaulting to source=hosted.
  assert(order.source === "hosted", "hosted order defaults to source=hosted");

  if (!process.exitCode) console.log("\nAll payment_orders metadata smoke checks passed.");
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

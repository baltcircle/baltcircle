// Explicit opt-in integration regression for migration 0021, never pointed at production.
// DATABASE_URL=postgresql:///takeride_capacity_test?host=/var/run/postgresql npx tsx script/test-maintenance-reason.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
const url = process.env.DATABASE_URL;
assert(url && /_test(?:\?|$)/.test(url), "An explicit *_test database is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE SCHEMA maintenance_reason_regression");
  await client.query("SET LOCAL search_path TO maintenance_reason_regression");
  await client.query(`CREATE TABLE bikes (
    id text PRIMARY KEY, status text NOT NULL, maintenance_reason text, battery integer, last_seen bigint
  )`);
  await client.query(`INSERT INTO bikes(id,status,maintenance_reason) VALUES
    ('stale','available','auto:low_battery'),
    ('offline','offline','auto:low_battery'),
    ('service','maintenance','auto:lock_open_unconfirmed')`);
  await client.query(readFileSync("migrations/0021_clear_stale_maintenance_reason.sql", "utf8"));
  const reason = async (id: string) =>
    (await client.query("SELECT maintenance_reason FROM bikes WHERE id=$1", [id])).rows[0].maintenance_reason;

  assert.equal(await reason("stale"), null, "backfill clears a reason left on an available bike");
  assert.equal(await reason("offline"), "auto:low_battery", "backfill keeps a live offline reason");
  assert.equal(await reason("service"), "auto:lock_open_unconfirmed", "backfill keeps a live maintenance reason");

  await client.query("UPDATE bikes SET status='available' WHERE id='offline'");
  assert.equal(await reason("offline"), null, "returning to service clears the reason");

  await client.query("UPDATE bikes SET status='rented' WHERE id='service'");
  assert.equal(await reason("service"), null, "any non-service status clears the reason");

  await client.query("UPDATE bikes SET status='offline', maintenance_reason='auto:low_battery' WHERE id='offline'");
  assert.equal(await reason("offline"), "auto:low_battery", "automatic offline still records its reason");

  await client.query("UPDATE bikes SET maintenance_reason='manual' WHERE id='stale'");
  assert.equal(await reason("stale"), null, "a reason cannot be written onto an available bike");

  await client.query("INSERT INTO bikes(id,status,maintenance_reason) VALUES ('new','available','auto:low_battery')");
  assert.equal(await reason("new"), null, "insert enforces the same invariant");

  await client.query("UPDATE bikes SET battery=5, last_seen=1 WHERE id='offline'");
  assert.equal(await reason("offline"), "auto:low_battery", "telemetry updates leave the reason intact");

  console.log("maintenance_reason invariant regressions passed");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}

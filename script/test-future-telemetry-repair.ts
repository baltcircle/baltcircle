// Explicit opt-in integration regression for migration 0023, never pointed at production.
// DATABASE_URL=postgresql:///takeride_capacity_test?host=/var/run/postgresql npx tsx script/test-future-telemetry-repair.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
const url = process.env.DATABASE_URL;
assert(url && /_test(?:\?|$)/.test(url), "An explicit *_test database is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE SCHEMA future_telemetry_regression");
  await client.query("SET LOCAL search_path TO future_telemetry_regression");
  await client.query("CREATE TABLE bike_telemetry (id serial PRIMARY KEY, bike_id text NOT NULL, t bigint NOT NULL)");
  await client.query(`CREATE TABLE locks (imei text PRIMARY KEY, last_seen_at bigint, last_location_at bigint, last_alarm_at bigint)`);
  await client.query(`CREATE TABLE bikes (id text PRIMARY KEY, last_seen bigint NOT NULL, lock_last_seen bigint)`);
  const now = Date.now();
  const H = 3600_000;
  await client.query(`INSERT INTO bike_telemetry(bike_id,t) VALUES
    ('a', $1::bigint - 60000), ('a', $1::bigint + 60000), ('a', $1::bigint + 6 * ${H}), ('b', $1::bigint + 30 * ${H})`, [now]);
  await client.query(`INSERT INTO locks VALUES
    ('future', $1::bigint + 6 * ${H}, $1::bigint + 6 * ${H}, $1::bigint + 6 * ${H}),
    ('ok', $1::bigint - 1000, $1::bigint - 2000, NULL)`, [now]);
  await client.query(`INSERT INTO bikes VALUES ('future', $1::bigint + 6 * ${H}, $1::bigint + 6 * ${H}), ('ok', $1::bigint - 1000, NULL)`, [now]);

  for (const stmt of readFileSync("migrations/0023_repair_future_dated_telemetry.sql", "utf8").split("--> statement-breakpoint")) {
    await client.query(stmt);
  }
  const after = Date.now();

  const rows = (await client.query("SELECT t::bigint AS t FROM bike_telemetry ORDER BY t")).rows.map((r) => Number(r.t));
  assert.deepEqual(rows, [now - 60000, now + 60000], "drops rows >2 min ahead, keeps in-tolerance and past rows");

  const lf = (await client.query("SELECT * FROM locks WHERE imei='future'")).rows[0];
  for (const col of ["last_seen_at", "last_location_at", "last_alarm_at"]) {
    const v = Number(lf[col]);
    assert(v <= after - H + 1000 && v >= now - H - 1000, `locks.${col} moved to ~1h ago (stale, not fresh)`);
  }
  const lo = (await client.query("SELECT * FROM locks WHERE imei='ok'")).rows[0];
  assert.equal(Number(lo.last_seen_at), now - 1000, "healthy lock last_seen_at untouched");
  assert.equal(lo.last_alarm_at, null, "NULL stays NULL");

  const bf = (await client.query("SELECT * FROM bikes WHERE id='future'")).rows[0];
  assert(Number(bf.last_seen) < now && Number(bf.lock_last_seen) < now, "future bike timestamps repaired");
  const bo = (await client.query("SELECT * FROM bikes WHERE id='ok'")).rows[0];
  assert.equal(Number(bo.last_seen), now - 1000, "healthy bike untouched");
  console.log("future-dated telemetry repair regressions passed");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}

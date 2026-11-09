// Explicit opt-in integration regression for migration 0022, never pointed at production.
// DATABASE_URL=postgresql:///takeride_capacity_test?host=/var/run/postgresql npx tsx script/test-spoofed-position-repair.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
const url = process.env.DATABASE_URL;
assert(url && /_test(?:\?|$)/.test(url), "An explicit *_test database is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE SCHEMA spoofed_position_regression");
  await client.query("SET LOCAL search_path TO spoofed_position_regression");
  await client.query("CREATE TABLE bikes (id text PRIMARY KEY, lat double precision, lng double precision)");
  await client.query(`CREATE TABLE locks (
    imei text PRIMARY KEY, bike_id text, last_latitude numeric, last_longitude numeric
  )`);
  await client.query(`CREATE TABLE bike_telemetry (
    id serial PRIMARY KEY, bike_id text NOT NULL, t bigint NOT NULL,
    x double precision, y double precision, lat double precision, lng double precision, hdop double precision
  )`);
  const now = Date.now();
  await client.query(`INSERT INTO bikes(id,lat,lng) VALUES
    ('spoofed', 9927, 91514), ('healthy', 300, 500), ('no_history', 9000, 90000)`);
  await client.query(`INSERT INTO locks(imei,bike_id,last_latitude,last_longitude) VALUES
    ('1','spoofed',54.1705,33.2331), ('2','healthy',54.95,20.47), ('3','no_history',54.1705,33.2331)`);
  await client.query(`INSERT INTO bike_telemetry(bike_id,t,x,y,lat,lng,hdop) VALUES
    ('spoofed', $1::bigint - 600000, 410, 320, 54.959, 20.480, 1.1),
    ('spoofed', $1::bigint - 300000, 411, 321, 54.959, 20.481, 14),
    ('spoofed', $1::bigint - 200000, 91514, 9927, 54.1705, 33.2331, 0.9),
    ('spoofed', $1::bigint + 86400000, 999, 999, 54.959, 20.480, 1.0),
    ('spoofed', $1::bigint - 100000, NULL, NULL, 54.959, 20.482, 1.0),
    ('healthy', $1::bigint - 100000, 1, 1, 54.95, 20.47, 1.0)`, [now]);
  await client.query(readFileSync("migrations/0022_restore_spoofed_bike_positions.sql", "utf8"));
  const pos = async (id: string) =>
    (await client.query("SELECT lat, lng FROM bikes WHERE id=$1", [id])).rows[0];

  assert.deepEqual(await pos("spoofed"), { lat: 320, lng: 410 },
    "restores the newest accurate, in-area, projected, non-future point");
  assert.deepEqual(await pos("healthy"), { lat: 300, lng: 500 }, "a bike with a trusted anchor is untouched");
  assert.deepEqual(await pos("no_history"), { lat: 9000, lng: 90000 }, "no trusted history -> left for the live heal");
  console.log("spoofed position repair regressions passed");
} finally {
  await client.query("ROLLBACK").catch(() => {});
  await client.end();
}

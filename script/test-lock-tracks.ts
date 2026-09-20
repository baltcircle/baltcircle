// Explicit opt-in integration regression, never pointed at production.
// DATABASE_URL=postgresql:///takeride_capacity_test?host=/var/run/postgresql npx tsx script/test-lock-tracks.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
const url = process.env.DATABASE_URL;
assert(url && /_test(?:\?|$)/.test(url), "An explicit *_test database is required");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("CREATE SCHEMA lock_track_regression");
  await client.query("SET LOCAL search_path TO lock_track_regression");
  await client.query(`CREATE TABLE rides (
    id serial PRIMARY KEY, bike_id text, status text, started_at bigint,
    ended_at bigint, distance_m float8 DEFAULT 0, track text DEFAULT '[]'
  ); CREATE TABLE bike_telemetry (
    id serial PRIMARY KEY, bike_id text, imei text, x float8, y float8,
    lat float8, lng float8, t bigint, hdop float8
  )`);
  await client.query(`INSERT INTO rides(id,bike_id,status,started_at,distance_m,track)
    VALUES (1,'bike','active',1000,999,'[[999,999,1000]]'),(2,'other','active',1000,777,'[]')`);
  await client.query(`INSERT INTO rides(id,bike_id,status,started_at,ended_at,distance_m,track)
    VALUES (3,'bike','completed',0,999,321,'[[8,8,0]]')`);
  const fix = async (t: number, lat: number, lng: number, extra = "") => client.query(
    `INSERT INTO bike_telemetry(bike_id,imei,x,y,lat,lng,t,hdop)
     VALUES ('bike','test-lock',${extra === "rejected" ? "NULL" : "1"},2,$1,$2,$3,$4)`,
    [lat, lng, t, extra === "bad-hdop" ? 20 : 1],
  );
  await fix(1000, 54.94, 20.48);
  await fix(21000, 54.9402, 20.48);
  const migration = readFileSync("migrations/0019_lock_only_ride_tracks.sql", "utf8")
    .replaceAll('"public"."rides"', '"rides"');
  await client.query(migration);
  await client.query(readFileSync("migrations/0020_lock_route_guards.sql", "utf8"));
  const state = async () => (await client.query("SELECT * FROM rides WHERE id=1")).rows[0];
  const count = async () => Number((await client.query("SELECT count(*) n FROM ride_lock_points WHERE ride_id=1")).rows[0].n);
  assert(Math.abs((await state()).distance_m - 22.238985) < 0.01, "migration uses WGS84, not phone distance");
  assert.equal((await client.query("SELECT distance_m FROM rides WHERE id=2")).rows[0].distance_m, 0);
  assert.equal((await state()).track, "[]", "active metadata does not carry the route");
  await fix(500, 54.94, 20.48);
  const historical = (await client.query("SELECT * FROM rides WHERE id=3")).rows[0];
  assert.equal(historical.distance_m, 321, "late replay cannot mix with historical phone distance");
  assert.equal(historical.track, "[[8,8,0]]", "historical snapshot preserved");
  await fix(21000, 54.9402, 20.48);
  assert.equal(await count(), 2, "repeated fix is idempotent");
  await fix(11000, 54.9401, 20.4801);
  const metres = (await state()).distance_m;
  assert(metres > 22.24 && metres < 30, "late fix replaces the old segment with two real segments");
  await fix(11000, 54.9401, 20.4801);
  assert.equal((await state()).distance_m, metres, "retry does not inflate distance");
  await fix(31000, 54.95, 20.5, "bad-hdop");
  await fix(32000, 54.95, 20.5, "rejected");
  assert.equal(await count(), 3, "bad GPS is not route input");
  await fix(200000, 54.95, 20.5);
  assert.equal((await state()).distance_m, metres, "GPS outage does not invent travelled distance");
  await client.query("UPDATE rides SET status='completed',ended_at=250000 WHERE id=1");
  await fix(220000, 54.9501, 20.5);
  assert.equal(JSON.parse((await state()).track).length, 5, "late flush updates completed snapshot");
  await fix(260000, 54.96, 20.5);
  assert.equal(await count(), 5, "post-ride movement excluded");
  await client.query(`INSERT INTO rides(id,bike_id,status,started_at,ended_at)
    VALUES (4,'bike','completed',300000,350000)`);
  await fix(310000, 54.96, 20.5);
  await fix(320000, 54.9601, 20.5);
  const late = (await client.query("SELECT * FROM rides WHERE id=4")).rows[0];
  assert.equal(JSON.parse(late.track).length, 2, "first-ever fix may flush after completion");
  assert(late.distance_m > 11 && late.distance_m < 12);
  await client.query("DELETE FROM bike_telemetry");
  assert.equal(await count(), 5, "raw telemetry retention cannot delete a ride");
  await client.query("DELETE FROM rides WHERE id=1");
  assert.equal(await count(), 0, "ride deletion cascades");
  console.log("Lock route integration: backfill, WGS84 distance, deduplication, out-of-order, GPS gaps, late completion, retention and cascade PASS");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}

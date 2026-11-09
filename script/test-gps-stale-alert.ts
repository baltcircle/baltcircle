// Destructive fixtures ONLY in the dedicated local test database.
// DATABASE_URL='postgresql:///takeride_admin_test?host=/var/run/postgresql' npx tsx script/test-gps-stale-alert.ts
import assert from "node:assert/strict";

const dsn = process.env.DATABASE_URL;
if (!dsn) throw new Error("Set DATABASE_URL to the isolated local test database");
const url = new URL(dsn);
if (url.pathname !== "/takeride_admin_test" ||
  !["", "localhost", "127.0.0.1"].includes(url.hostname) ||
  (url.searchParams.has("host") && url.searchParams.get("host") !== "/var/run/postgresql")) {
  throw new Error("Refusing fixtures outside the dedicated local takeride_admin_test database");
}
process.env.SKIP_DEMO_SEED = "1";
const { pool, bootstrapReady } = await import("../server/db/bootstrap");
const { storage } = await import("../server/storage");
const { GPS_STALE_ALERT_MS, GPS_STALE_CONFIRM_MS } = await import("../shared/geo");
const { resetStaleGpsRegistry } = await import("../server/storage/gps-stale-registry");
try {
  await bootstrapReady;
  await pool.query("TRUNCATE alerts, locks, bikes RESTART IDENTITY CASCADE");
  const now = 10_000_000_000;
  const stale = now - GPS_STALE_ALERT_MS - 60_000;
  const fresh = now - 60_000;
  const bikes: [string, string][] = [
    ["SPOOFED", "available"], ["FRESH", "available"], ["QUIET", "available"],
    ["SERVICE", "maintenance"], ["NEVER", "rented"], ["NOLOCK", "available"],
  ];
  for (const [id, status] of bikes) {
    await pool.query(
      `INSERT INTO bikes(id,model,status,battery,lat,lng,last_seen,idle_hours) VALUES ($1,'City',$2,80,1,1,1,0)`,
      [id, status],
    );
  }
  const lock = (imei: string, bikeId: string, seen: number, located: number | null) => pool.query(
    `INSERT INTO locks(imei,bike_id,status,last_seen_at,last_location_at,created_at,updated_at) VALUES ($1,$2,'active',$3,$4,1,1)`,
    [imei, bikeId, seen, located],
  );
  await lock("100000000000001", "SPOOFED", fresh, stale);   // on air, fix too old -> alert
  await lock("100000000000002", "FRESH", fresh, fresh);     // healthy
  await lock("100000000000003", "QUIET", stale, stale);     // lock itself silent -> not this alert
  await lock("100000000000004", "SERVICE", fresh, stale);   // hourly cadence status -> ignored
  await lock("100000000000005", "NEVER", fresh, null);      // never had a fix -> alert

  assert.deepEqual(await storage.findStaleGpsBikeIds(now), ["NEVER", "SPOOFED"]);

  resetStaleGpsRegistry();
  assert.equal(await storage.sweepStaleGpsAlerts(now), 0, "first sighting only arms the confirmation window");
  assert.equal(await storage.sweepStaleGpsAlerts(now + GPS_STALE_CONFIRM_MS), 2, "confirmed after the window");
  assert.equal(await storage.sweepStaleGpsAlerts(now + GPS_STALE_CONFIRM_MS + 60_000), 0, "dedup while unacknowledged");

  const alerts = (await storage.listAlerts()).filter((a) => a.kind === "gps_stale");
  assert.deepEqual(alerts.map((a) => a.bikeId).sort(), ["NEVER", "SPOOFED"]);
  assert.equal(alerts[0].severity, "high");

  await storage.acknowledgeAlert(alerts[0].id, "test");
  assert.equal((await storage.listAlerts()).filter((a) => a.kind === "gps_stale").length, 1);
  console.log("gps_stale alert regressions passed");
} finally {
  await pool.end();
}

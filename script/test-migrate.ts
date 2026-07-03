// Self-test for migrate-sqlite-to-pg.ts: build a legacy SQLite data.db, boot the
// PG schema into a throwaway DB, run the migration as a child process, verify.
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { createTestDb, dropTestDb, openTestDb } from "./smoke-pg";

const NAME = "migrate-selftest";
const SQLITE_PATH = "/tmp/bc-migrate-selftest.db";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

async function main() {
  for (const f of [SQLITE_PATH, `${SQLITE_PATH}-wal`, `${SQLITE_PATH}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }

  // ---- 1. Legacy SQLite source (booleans as INTEGER 0/1) ----
  const s = new Database(SQLITE_PATH);
  s.exec(`
    CREATE TABLE bikes (
      id TEXT PRIMARY KEY, model TEXT NOT NULL, status TEXT NOT NULL,
      battery INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      last_seen INTEGER NOT NULL, idle_hours REAL NOT NULL,
      flagged INTEGER NOT NULL DEFAULT 0, serial TEXT, lock_id TEXT,
      parking_id TEXT, notes TEXT, seed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
      role TEXT NOT NULL DEFAULT 'rider', consent_accepted_at INTEGER,
      consent_version TEXT, consent_ip TEXT, blocked_at INTEGER,
      blocked_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER
    );
    CREATE TABLE rides (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bike_id TEXT NOT NULL, user_id TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, start_lat REAL NOT NULL,
      start_lng REAL NOT NULL, end_lat REAL, end_lng REAL, track TEXT NOT NULL,
      distance_m REAL NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
      tariff TEXT NOT NULL, status TEXT NOT NULL
    );
  `);
  s.prepare(
    "INSERT INTO bikes (id, model, status, battery, lat, lng, last_seen, idle_hours, flagged, seed) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run("BC-777", "Test", "available", 90, 54.7, 20.5, Date.now(), 0.0, 1, 0);
  s.prepare(
    "INSERT INTO users (id, name, phone, role, created_at) VALUES (?,?,?,?,?)",
  ).run("u-1", "Мигрант", "+79990000000", "rider", Date.now());
  s.prepare(
    "INSERT INTO rides (bike_id, user_id, started_at, start_lat, start_lng, track, tariff, status) VALUES (?,?,?,?,?,?,?,?)",
  ).run("BC-777", "u-1", Date.now(), 54.7, 20.5, "[]", "payg", "active");
  s.prepare(
    "INSERT INTO rides (bike_id, user_id, started_at, start_lat, start_lng, track, tariff, status) VALUES (?,?,?,?,?,?,?,?)",
  ).run("BC-777", "u-1", Date.now(), 54.71, 20.51, "[]", "payg", "completed");
  s.close();

  // ---- 2. Fresh PG DB + bootstrap schema ----
  const { url } = await createTestDb(NAME);
  const boot = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "-e", "import('./server/db/bootstrap').then(m=>m.bootstrapReady).then(()=>process.exit(0))"],
    { env: { ...process.env, DATABASE_URL: url, SKIP_DEMO_SEED: "1" }, stdio: "inherit", timeout: 60000 },
  );
  assert(boot.status === 0, "bootstrap created the PG schema (no demo seed)");

  // ---- 3. Run the migration script as a child process ----
  const mig = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "script/migrate-sqlite-to-pg.ts"],
    { env: { ...process.env, DATABASE_URL: url, SQLITE_PATH }, stdio: "inherit", timeout: 60000 },
  );
  assert(mig.status === 0, "migration script exited 0");

  // ---- 4. Verify data landed correctly ----
  const db = await openTestDb(url);
  const bike = (await db.prepare("SELECT * FROM bikes WHERE id = ?").get("BC-777")) as any;
  assert(!!bike, "bike row migrated");
  assert(bike.flagged === true, "INTEGER 1 flag became boolean true");
  assert(bike.seed === false, "INTEGER 0 seed became boolean false");

  const user = (await db.prepare("SELECT * FROM users WHERE id = ?").get("u-1")) as any;
  assert(user?.name === "Мигрант", "user row migrated with UTF-8 name");

  const rideCount = Number(((await db.prepare("SELECT COUNT(*) AS c FROM rides").get()) as any).c);
  assert(rideCount === 2, "both ride rows migrated");
  const maxId = Number(((await db.prepare("SELECT MAX(id) AS m FROM rides").get()) as any).m);
  assert(maxId === 2, "serial ids preserved (max id = 2)");

  // ---- 5. Sequence was reset: a fresh insert gets id 3, not 1 ----
  const nextId = Number(
    ((await db
      .prepare(
        "INSERT INTO rides (bike_id, user_id, started_at, start_lat, start_lng, track, tariff, status) VALUES (?,?,?,?,?,?,?,?) RETURNING id",
      )
      .get("BC-777", "u-1", Date.now(), 54.7, 20.5, "[]", "payg", "active")) as any).id,
  );
  assert(nextId === 3, "sequence reset so new insert continues at id 3");

  // ---- 6. Idempotency: re-running inserts nothing new ----
  const mig2 = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "script/migrate-sqlite-to-pg.ts"],
    { env: { ...process.env, DATABASE_URL: url, SQLITE_PATH }, stdio: "inherit", timeout: 60000 },
  );
  assert(mig2.status === 0, "second migration run exited 0");
  const bikeCount = Number(((await db.prepare("SELECT COUNT(*) AS c FROM bikes").get()) as any).c);
  assert(bikeCount === 1, "idempotent: still exactly 1 bike after re-run");

  await db.close();
  console.log("\nAll migration self-test checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dropTestDb(NAME);
    for (const f of [SQLITE_PATH, `${SQLITE_PATH}-wal`, `${SQLITE_PATH}-shm`]) {
      if (existsSync(f)) rmSync(f);
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 200);
  });

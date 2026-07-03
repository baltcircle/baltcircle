// ---------- Database client + schema bootstrap + migrations + demo seed ----------
// Extracted from storage.ts to keep the storage god-file focused on the
// DatabaseStorage query layer. This module owns the single better-sqlite3
// connection, the CREATE TABLE bootstrap, every in-place column migration, the
// money->kopecks conversion, and the demo-data seed. All of it runs at import
// time (same order as before) so importing `db` guarantees a ready schema.
import { copyFileSync, existsSync } from "node:fs";
import {
  PARKINGS, OPERATING_ZONE, SLOW_ZONES, FORBIDDEN_ZONES,
  TARIFFS, tariffPriceKopecks,
} from "@shared/geo";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";

export const sqlite = new Database(process.env.DATABASE_PATH || "data.db");
sqlite.pragma("journal_mode = WAL");
// Wait (up to 5s) for a competing writer to release the lock instead of
// throwing SQLITE_BUSY immediately. Without this, concurrent writes (ride
// start/end, payments, session sweeps) surface as random 500s under load.
sqlite.pragma("busy_timeout = 5000");
// NORMAL is safe with WAL and much faster than FULL: on a crash the last
// committed transaction is still durable; only an OS-level crash could lose
// the most recent commit, which is acceptable for this workload.
sqlite.pragma("synchronous = NORMAL");
export const db = drizzle(sqlite);
// Exposed so the express-session store can reuse this single connection,
// keeping session rows in the same data.db that the Docker volume persists.
export const sqliteDb = sqlite;

// ---------- Schema bootstrap (since we skip drizzle migrations) ----------
sqlite.exec(`
CREATE TABLE IF NOT EXISTS bikes (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  battery INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  last_seen INTEGER NOT NULL,
  idle_hours REAL NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  serial TEXT,
  lock_id TEXT,
  parking_id TEXT,
  notes TEXT,
  seed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS parkings (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  capacity INTEGER NOT NULL, occupied INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  archived_at INTEGER,
  seed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL, polygon TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bike_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  start_lat REAL NOT NULL,
  start_lng REAL NOT NULL,
  end_lat REAL, end_lng REAL,
  track TEXT NOT NULL,
  distance_m REAL NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  tariff TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bike_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  assignee TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  closed_at INTEGER
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  active_tariff TEXT NOT NULL DEFAULT 'payg',
  tariff_expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS map_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#1d6f8e',
  points TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'rider',
  consent_accepted_at INTEGER,
  consent_version TEXT,
  consent_ip TEXT,
  blocked_at INTEGER,
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS otp_requests (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  provider_message_id TEXT,
  provider_status TEXT,
  provider_error TEXT,
  provider_checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS phone_change_requests (
  user_id TEXT PRIMARY KEY,
  new_phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'linked',
  provider TEXT,
  customer_key TEXT,
  card_id TEXT,
  rebill_id TEXT,
  request_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  bike_id TEXT NOT NULL,
  tariff_id TEXT NOT NULL,
  amount_kopecks INTEGER NOT NULL,
  payment_id TEXT,
  payment_url TEXT,
  source TEXT NOT NULL DEFAULT 'hosted',
  payment_method_id INTEGER,
  rebill_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  ride_id INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_details TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
`);

// ---------- Users column migration (production user fields) ----------
// Older prototype DBs created the users table with only id/name/phone/created_at.
// Real-user fields (email, role, consent metadata, updated_at) are added in
// place via ALTER TABLE so existing rider rows are preserved. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we inspect the table and add what's missing.
function migrateUsersTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  addColumn("email", "email TEXT");
  addColumn("role", "role TEXT NOT NULL DEFAULT 'rider'");
  addColumn("consent_accepted_at", "consent_accepted_at INTEGER");
  addColumn("consent_version", "consent_version TEXT");
  addColumn("consent_ip", "consent_ip TEXT");
  addColumn("blocked_at", "blocked_at INTEGER");
  addColumn("blocked_reason", "blocked_reason TEXT");
  addColumn("updated_at", "updated_at INTEGER");
}
migrateUsersTable();

// ---------- Bikes column migration (real-fleet ops fields) ----------
// Older DBs created the bikes table before serial/lock/parking/notes/seed
// existed. Add the columns in place so existing demo + manual rows survive.
// Existing rows predate the manual-add feature, so they are the demo fleet —
// backfill seed = 1 for them so the demo reseed can still refresh them.
function migrateBikesTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(bikes)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE bikes ADD COLUMN ${ddl}`);
  };
  addColumn("serial", "serial TEXT");
  addColumn("lock_id", "lock_id TEXT");
  addColumn("parking_id", "parking_id TEXT");
  addColumn("notes", "notes TEXT");
  if (!cols.includes("seed")) {
    sqlite.exec("ALTER TABLE bikes ADD COLUMN seed INTEGER NOT NULL DEFAULT 0");
    // Pre-existing rows are the demo fleet — mark them so reseed can manage them.
    sqlite.exec("UPDATE bikes SET seed = 1");
  }
}
migrateBikesTable();

// ---------- Tickets column migration (service ticket fields) ----------
// Older DBs created tickets with only id/bike_id/kind/message/status/created_at.
// Add the service-operations columns in place so existing tickets survive, and
// normalise the legacy "open" status to the new "new" entry state.
function migrateTicketsTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(tickets)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE tickets ADD COLUMN ${ddl}`);
  };
  addColumn("priority", "priority TEXT NOT NULL DEFAULT 'medium'");
  addColumn("title", "title TEXT NOT NULL DEFAULT ''");
  addColumn("assignee", "assignee TEXT");
  addColumn("updated_at", "updated_at INTEGER");
  addColumn("closed_at", "closed_at INTEGER");
  sqlite.exec("UPDATE tickets SET status = 'new' WHERE status = 'open'");
}
migrateTicketsTable();

// ---------- OTP requests column migration (SMS delivery diagnostics) ----------
// Older DBs created otp_requests before we tracked provider delivery state. Add
// the provider columns in place so existing pending rows survive. These hold no
// secrets — only the provider name, its sending id, its status/error text and a
// last-checked timestamp — and let staff query the provider's delivery status.
function migrateOtpRequestsTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(otp_requests)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE otp_requests ADD COLUMN ${ddl}`);
  };
  addColumn("provider", "provider TEXT");
  addColumn("provider_message_id", "provider_message_id TEXT");
  addColumn("provider_status", "provider_status TEXT");
  addColumn("provider_error", "provider_error TEXT");
  addColumn("provider_checked_at", "provider_checked_at INTEGER");
}
migrateOtpRequestsTable();

// ---------- Parkings column migration (operator management fields) ----------
// Older DBs created parkings with only id/name/lat/lng/capacity/occupied. Add
// the management columns in place so the existing 15 demo parkings survive and
// become editable. Pre-existing rows are the demo seed, so backfill seed = 1
// (and an active status) for them.
function migrateParkingsTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(parkings)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE parkings ADD COLUMN ${ddl}`);
  };
  addColumn("status", "status TEXT NOT NULL DEFAULT 'active'");
  addColumn("notes", "notes TEXT");
  addColumn("archived_at", "archived_at INTEGER");
  addColumn("created_at", "created_at INTEGER");
  addColumn("updated_at", "updated_at INTEGER");
  if (!cols.includes("seed")) {
    sqlite.exec("ALTER TABLE parkings ADD COLUMN seed INTEGER NOT NULL DEFAULT 0");
    // Pre-existing rows are the demo parkings — mark them so reseed can manage them.
    sqlite.exec("UPDATE parkings SET seed = 1");
  }
}
migrateParkingsTable();

// ---------- Map objects column migration (active toggle) ----------
// Older DBs created map_objects without the `active` column. Add it defaulting
// to active so existing operator-drawn objects keep rendering on the public map.
function migrateMapObjectsTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(map_objects)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("active")) {
    sqlite.exec("ALTER TABLE map_objects ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }
}
migrateMapObjectsTable();

// ---------- Payment methods column migration (real T-Bank metadata) ----------
// Older DBs created payment_methods with only id/user_id/type/label/status.
// Add the T-Bank acquirer columns in place so existing (legacy MVP) rows
// survive; they keep provider = NULL and are treated as non-real placeholders.
function migratePaymentMethodsTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(payment_methods)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE payment_methods ADD COLUMN ${ddl}`);
  };
  addColumn("provider", "provider TEXT");
  addColumn("customer_key", "customer_key TEXT");
  addColumn("card_id", "card_id TEXT");
  addColumn("rebill_id", "rebill_id TEXT");
  addColumn("request_key", "request_key TEXT");
  addColumn("updated_at", "updated_at INTEGER");
  addColumn("last_error_code", "last_error_code TEXT");
  addColumn("last_error_message", "last_error_message TEXT");
  addColumn("last_error_details", "last_error_details TEXT");
  addColumn("purpose", "purpose TEXT");
  addColumn("order_id", "order_id TEXT");
  addColumn("payment_id", "payment_id TEXT");
  addColumn("payment_url", "payment_url TEXT");
  addColumn("amount_kopecks", "amount_kopecks INTEGER");
  addColumn("brand", "brand TEXT");
  addColumn("account_token", "account_token TEXT"); // SBP AccountToken for ChargeQr recurring charges
  addColumn("refund_status", "refund_status TEXT"); // none | pending | refunded | failed (1 ₽ verification charge)
  addColumn("refund_error", "refund_error TEXT");   // reason when refund_status = failed
}
migratePaymentMethodsTable();

// ---------- Payment orders column migration (ride pay-then-start) ----------
// Earlier prototype DBs created payment_orders before the T-Bank Init metadata
// columns existed (a previous attempt left a table without payment_id, etc.).
// SQLite has no "ADD COLUMN IF NOT EXISTS", so inspect the table and add the
// missing columns in place. Every column added here is nullable or has a
// default, so the ALTERs are safe on a populated legacy table. The bare
// CREATE TABLE IF NOT EXISTS above never alters an existing table, which is why
// the in-place migration is required to fix the "no column named payment_id"
// insert failure on production DBs.
function migratePaymentOrdersTable() {
  const cols = (sqlite.prepare("PRAGMA table_info(payment_orders)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  const addColumn = (name: string, ddl: string) => {
    if (!cols.includes(name)) sqlite.exec(`ALTER TABLE payment_orders ADD COLUMN ${ddl}`);
  };
  addColumn("payment_id", "payment_id TEXT");
  addColumn("payment_url", "payment_url TEXT");
  addColumn("source", "source TEXT NOT NULL DEFAULT 'hosted'");
  addColumn("payment_method_id", "payment_method_id INTEGER");
  addColumn("rebill_id", "rebill_id TEXT");
  addColumn("status", "status TEXT NOT NULL DEFAULT 'pending'");
  addColumn("ride_id", "ride_id INTEGER");
  addColumn("last_error_code", "last_error_code TEXT");
  addColumn("last_error_message", "last_error_message TEXT");
  addColumn("last_error_details", "last_error_details TEXT");
  addColumn("amount_kopecks", "amount_kopecks INTEGER");
  addColumn("updated_at", "updated_at INTEGER");
}
migratePaymentOrdersTable();

// ---------- Money → kopecks migration (float rubles → integer kopecks) ----------
// Historically rides.cost / payments.amount / wallet.balance were REAL (float
// rubles), which loses precision on arithmetic. We move all money to INTEGER
// kopecks. SQLite has dynamic typing, so the physical column keeps its old
// affinity; this one-time pass multiplies every existing value by 100 and
// rounds to the nearest integer. Guarded by a meta flag so it runs exactly
// once. A copy of data.db is taken first so the pre-migration state is
// recoverable. New writes (below) always store kopecks.
function migrateMoneyToKopecks() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const done = sqlite.prepare("SELECT value FROM meta WHERE key = 'money_kopecks_migrated'").get() as
    | { value: string }
    | undefined;
  if (done?.value === "1") return;

  // Back up the DB file before touching money columns (best-effort; skipped for
  // the in-memory/absent file case). The backup name is timestamped so repeated
  // fresh deploys don't clobber a prior backup.
  const dbPath = process.env.DATABASE_PATH || "data.db";
  try {
    if (existsSync(dbPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backup = `${dbPath}.pre-kopecks-${stamp}.bak`;
      if (!existsSync(backup)) copyFileSync(dbPath, backup);
    }
  } catch {
    // A failed backup must not block startup; the conversion below is still
    // idempotent-guarded and the operator can restore from volume snapshots.
  }

  // Convert in one transaction: rides.cost, payments.amount, wallet.balance.
  // ROUND(x * 100) turns float rubles into integer kopecks; values already
  // stored as whole rubles (e.g. 350) become 35000. This is a no-op-safe pass
  // only run once thanks to the meta flag.
  const convert = sqlite.transaction(() => {
    sqlite.exec("UPDATE rides SET cost = CAST(ROUND(cost * 100) AS INTEGER)");
    sqlite.exec("UPDATE payments SET amount = CAST(ROUND(amount * 100) AS INTEGER)");
    sqlite.exec("UPDATE wallet SET balance = CAST(ROUND(balance * 100) AS INTEGER)");
    sqlite
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('money_kopecks_migrated', '1')")
      .run();
  });
  convert();
}
migrateMoneyToKopecks();


const MODELS = ["BC Cruiser", "BC Comfort", "BC City+", "BC Lite"];

// Bump this whenever the demo geography/seed data changes so existing
// prototype databases get refreshed automatically on next startup
// (MVP demo data — safe to wipe & reseed, no real user data).
const DEMO_DATA_VERSION = 4;

// Demo fleet size — kept small (a handful of sample bikes) so QR/rental flow
// and admin tables have data without flooding the map/tables with 100 bikes.
const DEMO_BIKE_COUNT = 5;

// ---------- Demo data migration (MVP prototype only) ----------
//
// Older prototype DBs were seeded with Kaliningrad demo parkings. The map was
// refocused on the Baltic coastal towns (Светлогорск / Пионерский /
// Зеленоградск), so an existing DB must be refreshed to the new demo data.
// We persist a version marker; if it's missing or stale (or we detect the old
// parking layout), we clear and reseed all demo tables. This avoids manual SSH.
function migrateDemoData() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = sqlite.prepare("SELECT value FROM meta WHERE key = 'demo_data_version'").get() as
    | { value: string }
    | undefined;
  const storedVersion = row ? parseInt(row.value, 10) : 0;

  // Detect legacy data: any parking whose name doesn't belong to the current
  // coastal towns indicates an old (e.g. Kaliningrad) seed.
  const coastalTowns = ["Светлогорск", "Пионерский", "Зеленоградск"];
  const parkingCount = (sqlite.prepare("SELECT COUNT(*) AS c FROM parkings").get() as { c: number }).c;
  let hasLegacyParkings = false;
  if (parkingCount > 0) {
    const names = sqlite.prepare("SELECT name FROM parkings").all() as { name: string }[];
    hasLegacyParkings = names.some((p) => !coastalTowns.some((t) => p.name.includes(t)));
  }

  const needsReseed = storedVersion < DEMO_DATA_VERSION || hasLegacyParkings;
  if (!needsReseed) return;

  // Refresh demo data without destroying operator-added real bikes. Only rows
  // that belong to the demo seed are cleared; manually-added bikes (seed = 0)
  // and any rides/tickets referencing them are preserved. Wrapped in a
  // transaction so startup sees either the old or the fully refreshed state.
  const reset = sqlite.transaction(() => {
    // Demo rides/tickets reference demo (seed) bikes only. Clear those, plus the
    // wider demo payments/wallet/zones/parkings which carry no manual data.
    sqlite.exec(`
      DELETE FROM ticket_comments WHERE ticket_id IN (
        SELECT id FROM tickets WHERE bike_id IN (SELECT id FROM bikes WHERE seed = 1)
      );
      DELETE FROM rides   WHERE bike_id IN (SELECT id FROM bikes WHERE seed = 1);
      DELETE FROM tickets WHERE bike_id IN (SELECT id FROM bikes WHERE seed = 1);
      DELETE FROM payments;
      DELETE FROM wallet;
      DELETE FROM zones;
      DELETE FROM parkings;
      DELETE FROM bikes   WHERE seed = 1;
    `);
    // Reset AUTOINCREMENT counters for tickets/payments if present. `rides` is
    // intentionally left so ids stay stable for any preserved manual-bike rides.
    try {
      sqlite.exec("DELETE FROM sqlite_sequence WHERE name IN ('tickets','ticket_comments','payments')");
    } catch {
      // sqlite_sequence only exists once an AUTOINCREMENT table has rows; ignore.
    }
    populateDemoData();
    sqlite
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo_data_version', ?)")
      .run(String(DEMO_DATA_VERSION));
  });
  reset();
}

function seedRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function populateDemoData() {
  const rng = seedRng(20260525);
  const now = Date.now();

  // Bikes — a small sample fleet placed near parkings. All seeded as
  // "available" with healthy batteries so the QR/rental demo flow always has a
  // bike to pick, while still giving admin tables real sample rows.
  const insertBike = sqlite.prepare(
    `INSERT INTO bikes (id, model, status, battery, lat, lng, last_seen, idle_hours, flagged, parking_id, seed)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`
  );
  for (let i = 1; i <= DEMO_BIKE_COUNT; i++) {
    const id = `BC-${String(i).padStart(3, "0")}`;
    const model = MODELS[i % MODELS.length];
    const p = PARKINGS[i % PARKINGS.length];
    const x = p.x + (rng() - 0.5) * 18;
    const y = p.y + (rng() - 0.5) * 18;

    const battery = Math.max(45, Math.min(100, Math.round(60 + rng() * 40)));
    const idleHours = +(rng() * 6).toFixed(1);
    const status = "available";
    const flagged = 0;
    const lastSeen = now - Math.round(idleHours * 3600 * 1000);

    insertBike.run(id, model, status, battery, y, x, lastSeen, idleHours, flagged, p.id);
  }

  // Parkings — seeded active and marked seed = 1 so a future reseed can refresh
  // them without touching operator-added points.
  const insertP = sqlite.prepare(
    `INSERT INTO parkings (id, name, lat, lng, capacity, occupied, status, notes, archived_at, seed, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'active',NULL,NULL,1,?,NULL)`,
  );
  for (const p of PARKINGS) {
    const occupied = Math.min(p.capacity, Math.floor(rng() * p.capacity * 0.9));
    insertP.run(p.id, p.name, p.y, p.x, p.capacity, occupied, now);
  }

  // Zones
  const insertZ = sqlite.prepare("INSERT INTO zones VALUES (?,?,?,?)");
  insertZ.run("Z-OP", "Зона обслуживания побережья", "operating", JSON.stringify(OPERATING_ZONE));
  for (const s of SLOW_ZONES) insertZ.run(s.id, s.name, "slow", JSON.stringify(s.polygon));
  for (const f of FORBIDDEN_ZONES) insertZ.run(f.id, f.name, "forbidden", JSON.stringify(f.polygon));

  // Wallet — single demo user (seeded with a top-up so MVP can be exercised immediately)
  sqlite.prepare(
    "INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at) VALUES ('demo', 50000, 'h2', NULL)"
  ).run();

  // Seed a couple of maintenance tickets against existing sample bikes so the
  // admin tickets table has data without referencing bikes that no longer exist.
  const sampleBikeIds = sqlite.prepare("SELECT id FROM bikes ORDER BY id").all() as { id: string }[];
  const insertT = sqlite.prepare(
    "INSERT INTO tickets (bike_id, kind, priority, title, message, assignee, status, created_at, updated_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  );
  if (sampleBikeIds[0]) insertT.run(sampleBikeIds[0].id, "wheel_puncture", "high", "Спущено колесо", "Пользователь сообщил: спущено заднее колесо", null, "new", now - 5400000, null, null);
  if (sampleBikeIds[1]) insertT.run(sampleBikeIds[1].id, "lock", "critical", "Не фиксируется замок", "Пользователь сообщил: не фиксируется замок", "Сервисная бригада", "in_progress", now - 86400000, now - 80000000, null);
  if (sampleBikeIds[2]) insertT.run(sampleBikeIds[2].id, "dirty", "low", "Грязный велосипед", "Требуется мойка после поездки в дождь", null, "resolved", now - 172800000, now - 90000000, now - 90000000);

  // Seed some past payments and rides to give analytics a baseline
  const insertPay = sqlite.prepare("INSERT INTO payments (user_id, amount, kind, description, created_at) VALUES (?,?,?,?,?)");
  insertPay.run("demo", 50000, "topup", "Пополнение через банковскую карту •• 4242", now - 86400000 * 6);

  const insertR = sqlite.prepare(
    "INSERT INTO rides (bike_id, user_id, started_at, ended_at, start_lat, start_lng, end_lat, end_lng, track, distance_m, cost, tariff, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  const rideUsers = ["demo", "user-2", "user-3", "user-4", "user-5"];
  for (let i = 0; i < 240; i++) {
    const bikeIdx = 1 + Math.floor(rng() * DEMO_BIKE_COUNT);
    const bikeId = `BC-${String(bikeIdx).padStart(3, "0")}`;
    const user = rideUsers[Math.floor(rng() * rideUsers.length)];
    const daysAgo = Math.floor(rng() * 28);
    const startedAt = now - daysAgo * 86400000 - Math.floor(rng() * 86400000);
    const duration = Math.floor(180000 + rng() * 1800000); // 3–33 min
    const endedAt = startedAt + duration;
    const sp = PARKINGS[Math.floor(rng() * PARKINGS.length)];
    const ep = PARKINGS[Math.floor(rng() * PARKINGS.length)];
    const trackPts: [number, number, number][] = [];
    const steps = 8;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = sp.x + (ep.x - sp.x) * t + (rng() - 0.5) * 14;
      const y = sp.y + (ep.y - sp.y) * t + (rng() - 0.5) * 14;
      trackPts.push([x, y, startedAt + (duration * t)]);
    }
    const distance = Math.floor(800 + rng() * 5200);
    // Hourly prepaid model: rider buys a fixed-hour tariff up front. Demo rides
    // all fit inside one hour, so seed them as h1 (350 ₽) — cost in kopecks.
    const seedTariff = TARIFFS[0]; // h1
    const cost = tariffPriceKopecks(seedTariff);
    insertR.run(
      bikeId, user, startedAt, endedAt,
      sp.y, sp.x, ep.y, ep.x,
      JSON.stringify(trackPts), distance, cost, seedTariff.id, "completed",
    );
  }
}

// On a fresh DB, seed once and record the current demo data version.
// On an existing DB, migrate/refresh stale or legacy (Kaliningrad) demo data.
function bootstrapDemoData() {
  const count = sqlite.prepare("SELECT COUNT(*) AS c FROM bikes").get() as { c: number };
  if (count.c === 0) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    populateDemoData();
    sqlite
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('demo_data_version', ?)")
      .run(String(DEMO_DATA_VERSION));
    return;
  }
  migrateDemoData();
}
bootstrapDemoData();

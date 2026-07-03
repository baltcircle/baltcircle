import {
  bikes, parkings, zones, rides, tickets, ticketComments, payments, wallet, mapObjects, users,
  otpRequests, phoneChangeRequests, paymentMethods, supportTickets, paymentOrders,
  TICKET_CLOSED_STATUSES,
} from "@shared/schema";
import type {
  Bike, Parking, ZoneRow, Ride, AdminRide, Ticket, TicketComment, TicketWithComments, Payment, Wallet,
  MapObject, InsertMapObject, User, OtpRequest, UserRole, UpdateProfileInput,
  PhoneChangeRequest, PaymentMethod, SupportTicket, PaymentOrder,
  AdminCreateBikeInput, AdminUpdateBikeInput, CreateTicketInput, UpdateTicketInput,
  AdminCreateParkingInput, AdminUpdateParkingInput,
} from "@shared/schema";
import { CONSENT_VERSION } from "@shared/schema";
import { randomUUID, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import {
  PARKINGS, OPERATING_ZONE, SLOW_ZONES, FORBIDDEN_ZONES, MAP_W, MAP_H,
  TARIFFS, tariffPriceKopecks,
} from "@shared/geo";
import { computeOverage, finalRideCost } from "@shared/billing";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, sql } from "drizzle-orm";

const sqlite = new Database(process.env.DATABASE_PATH || "data.db");
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

// ---------- Storage interface ----------

// Normalize a user-entered phone to a storable canonical form: keep digits and
// a single optional leading "+". A Russian "8XXXXXXXXXX" national number is
// converted to "+7XXXXXXXXXX" so duplicates and display stay consistent.
// ---------- OTP policy ----------
export const OTP_TTL_MS = 5 * 60 * 1000;     // code valid 5 minutes
export const OTP_MAX_ATTEMPTS = 5;           // wrong-code tries before lockout
export const OTP_RESEND_LOCK_MS = 60 * 1000; // min seconds between SMS per phone

// Secret used to HMAC the OTP before storage. Falls back to the session secret
// (or a dev constant) so codes are never persisted in plaintext even locally.
function otpSecret(): string {
  return process.env.OTP_SECRET || process.env.SESSION_SECRET || "baltcircle-dev-otp-secret";
}

function hashOtp(phone: string, code: string): string {
  // Bind the hash to the phone so a leaked hash can't be replayed against
  // another number, and so identical codes for different phones differ.
  return createHmac("sha256", otpSecret()).update(`${phone}:${code}`).digest("hex");
}

function generateOtp(): string {
  // 4-digit numeric code (1000–9999) — matches the SMS copy and UI input.
  return String(randomInt(1000, 10000));
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!hasPlus && digits.length === 11 && digits.startsWith("8")) {
    digits = "7" + digits.slice(1);
    return "+" + digits;
  }
  return hasPlus ? "+" + digits : digits;
}

// Temporary admin bootstrap. ADMIN_PHONE_NUMBERS is a comma-separated list of
// phone numbers (any format) that should be granted the admin role. Nothing is
// hardcoded: with the env unset the set is empty and no one is auto-promoted.
// Each entry is normalized the same way rider phones are, so "8…" / "+7…" /
// spaced forms all match. This is a stopgap until a proper role-admin UI exists.
function adminPhoneSet(): Set<string> {
  const raw = process.env.ADMIN_PHONE_NUMBERS || "";
  return new Set(
    raw
      .split(",")
      .map((p) => normalizePhone(p))
      .filter((p) => p.replace(/\D/g, "").length >= 10),
  );
}

export function isAdminPhone(phone: string): boolean {
  return adminPhoneSet().has(normalizePhone(phone));
}

// Resolve the role a user should currently have. The ADMIN_PHONE_NUMBERS env
// takes precedence so a phone added to the list is promoted on next lookup even
// if the stored row predates the list; otherwise the persisted role is used.
export function resolveRole(user: User): UserRole {
  if (isAdminPhone(user.phone)) return "admin";
  return (user.role as UserRole) ?? "rider";
}

export interface IStorage {
  // users
  getUser(id: string): User | undefined;
  getUserByPhone(phone: string): User | undefined;
  updateProfile(id: string, patch: UpdateProfileInput): { user: User } | { error: string };
  // admin user management
  listUsers(): User[];
  setUserRole(id: string, role: UserRole): { user: User } | { error: string };
  setUserBlocked(id: string, blocked: boolean, reason?: string): { user: User } | { error: string };
  // OTP verification
  startOtp(input: { name: string; phone: string }):
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number };
  verifyOtp(input: { phone: string; code: string; consentIp?: string }): { user: User } | { error: string };
  // OTP delivery diagnostics (provider id/status persisted per phone)
  recordOtpSend(input: {
    phone: string;
    provider?: string;
    providerMessageId?: string;
    providerStatus?: string;
    providerError?: string;
  }): void;
  getLastOtpSend(phone: string): OtpRequest | undefined;
  updateOtpProviderStatus(input: {
    phone: string;
    providerStatus?: string;
    providerError?: string;
  }): void;
  // phone change (SMS OTP for an existing account)
  startPhoneChange(input: { userId: string; phone: string }):
    | { ok: true; phone: string; code: string; resendInSec: number }
    | { error: string; retryAfterSec?: number };
  verifyPhoneChange(input: { userId: string; code: string }): { user: User } | { error: string };
  // payment methods (metadata only — no card data)
  listPaymentMethods(userId: string): PaymentMethod[];
  linkPaymentMethod(userId: string, type: "card" | "sbp"): PaymentMethod;
  unlinkPaymentMethod(userId: string, id: number): boolean;
  // T-Bank card binding (real acquiring metadata)
  createPendingCardMethod(input: { userId: string; customerKey: string; requestKey?: string }): PaymentMethod;
  createPendingBindPayment(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    amountKopecks: number;
  }): PaymentMethod;
  // SBP account binding (AddAccountQr): a pending sbp-type method keyed by the
  // RequestKey so the notification/state poll can attach the AccountToken.
  createPendingSbpBinding(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    requestKey?: string;
  }): PaymentMethod;
  getPaymentMethod(id: number): PaymentMethod | undefined;
  findPendingCardMethod(userId: string): PaymentMethod | undefined;
  findCardMethodByOrderId(orderId: string): PaymentMethod | undefined;
  findCardMethodByRequestKey(userId: string, requestKey: string): PaymentMethod | undefined;
  // Locate any T-Bank method (card or sbp) by RequestKey alone — used by the SBP
  // binding notification, which carries a RequestKey but no user id.
  findMethodByRequestKey(requestKey: string): PaymentMethod | undefined;
  // The rider's saved SBP account usable for a recurring charge (active + token).
  getActiveSavedSbp(userId: string, paymentMethodId?: number): PaymentMethod | undefined;
  updatePaymentMethod(id: number, patch: Partial<PaymentMethod>): PaymentMethod | undefined;
  // The rider's saved T-Bank card usable for a recurring charge (active + RebillId)
  getActiveSavedCard(userId: string, paymentMethodId?: number): PaymentMethod | undefined;
  // T-Bank ride payment orders (hosted pay-then-start AND saved-card charge)
  createRidePaymentOrder(input: {
    orderId: string;
    userId: string;
    bikeId: string;
    tariffId: string;
    amountKopecks: number;
    source?: "hosted" | "saved_card";
    paymentMethodId?: number;
    rebillId?: string;
  }): PaymentOrder;
  getRidePaymentOrder(orderId: string): PaymentOrder | undefined;
  updateRidePaymentOrder(id: number, patch: Partial<PaymentOrder>): PaymentOrder | undefined;
  // support tickets (rider help requests)
  listSupportTickets(userId: string): SupportTicket[];
  createSupportTicket(input: { userId: string; subject: string; message: string }): SupportTicket;
  // bikes
  listBikes(opts?: { includeArchived?: boolean }): Bike[];
  getBike(id: string): Bike | undefined;
  updateBike(id: string, patch: Partial<Bike>): Bike | undefined;
  // bikes — admin CRUD (staff only)
  createBike(input: AdminCreateBikeInput): { bike: Bike } | { error: string };
  adminUpdateBike(id: string, patch: AdminUpdateBikeInput): { bike: Bike } | { error: string };
  archiveBike(id: string): { bike: Bike } | { error: string };
  deleteBike(id: string): { ok: true } | { error: string; archived?: Bike };
  // parkings
  listParkings(opts?: { includeInactive?: boolean; includeArchived?: boolean }): Parking[];
  getParking(id: string): Parking | undefined;
  createParking(input: AdminCreateParkingInput): { parking: Parking } | { error: string };
  updateParking(id: string, patch: AdminUpdateParkingInput): { parking: Parking } | { error: string };
  archiveParking(id: string): { parking: Parking } | { error: string };
  restoreParking(id: string): { parking: Parking } | { error: string };
  deleteParking(id: string): { ok: true } | { error: string; archived?: Parking };
  // zones
  listZones(): ZoneRow[];
  // rides
  startRide(input: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }): Ride | { error: string };
  appendRidePoint(rideId: number, x: number, y: number): Ride | undefined;
  endRide(rideId: number): Ride | undefined;
  getRide(rideId: number): Ride | undefined;
  getActiveRide(userId: string): Ride | undefined;
  listRides(opts?: { userId?: string; limit?: number }): Ride[];
  listAdminRides(opts?: { limit?: number }): AdminRide[];
  // payments / wallet
  getWallet(userId: string): Wallet;
  topUp(userId: string, amount: number): { wallet: Wallet; payment: Payment };
  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number): { wallet: Wallet; payment: Payment };
  listPayments(userId: string): Payment[];
  // service / maintenance tickets
  listTickets(): Ticket[];
  getTicket(id: number): TicketWithComments | undefined;
  createTicket(input: CreateTicketInput): TicketWithComments;
  updateTicket(id: number, patch: UpdateTicketInput, actor: string): TicketWithComments | undefined;
  addTicketComment(id: number, author: string, body: string): TicketWithComments | undefined;
  // map objects (operator-drawn routes/zones)
  listMapObjects(opts?: { activeOnly?: boolean }): MapObject[];
  createMapObject(input: InsertMapObject): MapObject;
  setMapObjectActive(id: number, active: boolean): MapObject | undefined;
  deleteMapObject(id: number): boolean;
  // analytics
  analytics(): any;
  // period-scoped analytics for the admin "Аналитика v1" page
  adminAnalytics(range: { from: number; to: number }): any;
}

export class DatabaseStorage implements IStorage {
  // Apply the env-driven admin override so callers always see the effective
  // role without each one re-checking ADMIN_PHONE_NUMBERS.
  private withResolvedRole(user: User | undefined): User | undefined {
    if (!user) return user;
    return { ...user, role: resolveRole(user) };
  }

  getUser(id: string) {
    const u = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    return this.withResolvedRole(u);
  }

  getUserByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    const u = db.select().from(users).where(eq(users.phone, normalized)).get() as User | undefined;
    return this.withResolvedRole(u);
  }

  // Self-service profile update for the current user. Only name/email are
  // mutable here; phone changes must go through SMS OTP (not this endpoint).
  updateProfile(id: string, patch: UpdateProfileInput) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };

    const set: Partial<User> = { updatedAt: Date.now() };
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.email !== undefined) {
      const email = patch.email.trim();
      set.email = email.length > 0 ? email : null;
    }
    db.update(users).set(set as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  // ---------- Admin user management ----------
  // List every registered user, newest first, with effective roles applied so
  // the admin table shows the same role the rest of the app enforces (the
  // ADMIN_PHONE_NUMBERS override can make a stored "rider" effectively admin).
  listUsers() {
    const rows = db.select().from(users).orderBy(desc(users.createdAt)).all() as User[];
    return rows.map((u) => this.withResolvedRole(u)!);
  }

  setUserRole(id: string, role: UserRole) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };
    db.update(users).set({ role, updatedAt: Date.now() } as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  setUserBlocked(id: string, blocked: boolean, reason?: string) {
    const existing = db.select().from(users).where(eq(users.id, id)).get() as User | undefined;
    if (!existing) return { error: "Пользователь не найден" };
    const set: Partial<User> = {
      blockedAt: blocked ? Date.now() : null,
      blockedReason: blocked ? (reason?.trim() || null) : null,
      updatedAt: Date.now(),
    };
    db.update(users).set(set as any).where(eq(users.id, id)).run();
    return { user: this.getUser(id)! };
  }

  // ---------- OTP verification ----------
  // Step 1: create/refresh a pending code for this phone and hand the plaintext
  // back to the caller so it can be dispatched via SMS. The code itself is only
  // stored as an HMAC. Enforces a per-phone resend lock.
  startOtp({ name, phone }: { name: string; phone: string }) {
    const cleanName = name.trim();
    const cleanPhone = normalizePhone(phone);
    const digits = cleanPhone.replace(/\D/g, "");
    if (cleanName.length < 2) return { error: "Имя должно содержать минимум 2 символа" };
    if (digits.length < 10) return { error: "Введите корректный номер телефона" };

    const now = Date.now();
    const existing = db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).get() as OtpRequest | undefined;

    if (existing && !existing.consumed) {
      const sinceLast = now - existing.lastSentAt;
      if (sinceLast < OTP_RESEND_LOCK_MS) {
        const retryAfterSec = Math.ceil((OTP_RESEND_LOCK_MS - sinceLast) / 1000);
        return {
          error: `Повторная отправка кода будет доступна через ${retryAfterSec} с`,
          retryAfterSec,
        };
      }
    }

    const code = generateOtp();
    const codeHash = hashOtp(cleanPhone, code);
    const expiresAt = now + OTP_TTL_MS;

    db.insert(otpRequests)
      .values({ phone: cleanPhone, name: cleanName, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: otpRequests.phone,
        set: { name: cleanName, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      })
      .run();

    return { ok: true as const, phone: cleanPhone, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  // Step 2: verify a submitted code. On success the rider is created (or reused
  // if the phone already registered) and the request row is consumed.
  verifyOtp({ phone, code, consentIp }: { phone: string; code: string; consentIp?: string }) {
    const cleanPhone = normalizePhone(phone);
    const req = db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).get() as OtpRequest | undefined;

    if (!req || req.consumed) {
      return { error: "Запросите код подтверждения заново" };
    }
    if (Date.now() > req.expiresAt) {
      return { error: "Срок действия кода истёк. Запросите новый код" };
    }
    if (req.attempts >= OTP_MAX_ATTEMPTS) {
      return { error: "Слишком много попыток. Запросите новый код" };
    }

    const expected = req.codeHash;
    const provided = hashOtp(cleanPhone, code.trim());
    if (!safeEqualHex(provided, expected)) {
      const attempts = req.attempts + 1;
      db.update(otpRequests).set({ attempts }).where(eq(otpRequests.phone, cleanPhone)).run();
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Correct code — consume the request so it can't be reused.
    db.update(otpRequests).set({ consumed: true }).where(eq(otpRequests.phone, cleanPhone)).run();

    // Consent was accepted at OTP start (the API requires consent: true before
    // a code is sent), so record the consent metadata on verify when the rider
    // row is created/refreshed. The verified phone IS the proof of consent.
    const now = Date.now();
    const role: UserRole = isAdminPhone(cleanPhone) ? "admin" : "rider";

    // Reuse an existing rider for this phone (keeps rides/wallet) or create one.
    const existing = db.select().from(users).where(eq(users.phone, cleanPhone)).get() as
      | User
      | undefined;
    if (existing) {
      const set: Partial<User> = {
        updatedAt: now,
        consentAcceptedAt: now,
        consentVersion: CONSENT_VERSION,
        consentIp: consentIp ?? existing.consentIp ?? null,
        // Keep an already-elevated role (e.g. operator) but ensure admin phones
        // are promoted. Never silently demote a stored operator/admin.
        role: role === "admin" ? "admin" : (existing.role as UserRole),
      };
      if (existing.name !== req.name) set.name = req.name;
      db.update(users).set(set as any).where(eq(users.id, existing.id)).run();
      return { user: this.getUser(existing.id)! };
    }
    db.insert(users).values({
      id: randomUUID(),
      name: req.name,
      phone: cleanPhone,
      email: null,
      role,
      consentAcceptedAt: now,
      consentVersion: CONSENT_VERSION,
      consentIp: consentIp ?? null,
      createdAt: now,
      updatedAt: now,
    } as any).run();
    return { user: this.getUserByPhone(cleanPhone)! };
  }

  // ---------- OTP delivery diagnostics ----------
  // Persist the provider id/status returned when an OTP SMS was accepted (or the
  // safe error when it was not). Keyed by phone, matching the single pending OTP
  // row. A no-op if the row was already consumed/removed by a concurrent verify.
  recordOtpSend({ phone, provider, providerMessageId, providerStatus, providerError }: {
    phone: string;
    provider?: string;
    providerMessageId?: string;
    providerStatus?: string;
    providerError?: string;
  }) {
    const cleanPhone = normalizePhone(phone);
    db.update(otpRequests)
      .set({
        provider: provider ?? null,
        providerMessageId: providerMessageId ?? null,
        providerStatus: providerStatus ?? null,
        providerError: providerError ?? null,
        providerCheckedAt: Date.now(),
      })
      .where(eq(otpRequests.phone, cleanPhone))
      .run();
  }

  // Read the latest OTP request row for a phone (includes provider diagnostics).
  getLastOtpSend(phone: string): OtpRequest | undefined {
    const cleanPhone = normalizePhone(phone);
    return db.select().from(otpRequests)
      .where(eq(otpRequests.phone, cleanPhone)).get() as OtpRequest | undefined;
  }

  // Update only the provider delivery status/error after a status refresh. Does
  // not touch the OTP lifecycle fields (code/expiry/attempts/consumed).
  updateOtpProviderStatus({ phone, providerStatus, providerError }: {
    phone: string;
    providerStatus?: string;
    providerError?: string;
  }) {
    const cleanPhone = normalizePhone(phone);
    db.update(otpRequests)
      .set({
        providerStatus: providerStatus ?? null,
        providerError: providerError ?? null,
        providerCheckedAt: Date.now(),
      })
      .where(eq(otpRequests.phone, cleanPhone))
      .run();
  }

  // ---------- Phone change (SMS OTP, existing account) ----------
  // Step 1: a logged-in rider requests a code sent to a NEW number. The pending
  // request is keyed by the user id and stores the target phone; the code is
  // stored only as an HMAC. Enforces the same per-request resend lock as
  // registration and refuses a number already used by another account.
  startPhoneChange({ userId, phone }: { userId: string; phone: string }) {
    const user = db.select().from(users).where(eq(users.id, userId)).get() as User | undefined;
    if (!user) return { error: "Пользователь не найден" };

    const newPhone = normalizePhone(phone);
    const digits = newPhone.replace(/\D/g, "");
    if (digits.length < 10) return { error: "Введите корректный номер телефона" };
    if (newPhone === user.phone) return { error: "Это уже ваш текущий номер" };

    // Don't allow merging into another account's number.
    const taken = db.select().from(users).where(eq(users.phone, newPhone)).get() as User | undefined;
    if (taken && taken.id !== userId) {
      return { error: "Этот номер уже используется другим аккаунтом" };
    }

    const now = Date.now();
    const existing = db.select().from(phoneChangeRequests)
      .where(eq(phoneChangeRequests.userId, userId)).get() as PhoneChangeRequest | undefined;
    if (existing && !existing.consumed) {
      const sinceLast = now - existing.lastSentAt;
      if (sinceLast < OTP_RESEND_LOCK_MS) {
        const retryAfterSec = Math.ceil((OTP_RESEND_LOCK_MS - sinceLast) / 1000);
        return { error: `Повторная отправка кода будет доступна через ${retryAfterSec} с`, retryAfterSec };
      }
    }

    const code = generateOtp();
    const codeHash = hashOtp(newPhone, code);
    const expiresAt = now + OTP_TTL_MS;
    db.insert(phoneChangeRequests)
      .values({ userId, newPhone, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false })
      .onConflictDoUpdate({
        target: phoneChangeRequests.userId,
        set: { newPhone, codeHash, expiresAt, attempts: 0, lastSentAt: now, consumed: false },
      })
      .run();

    return { ok: true as const, phone: newPhone, code, resendInSec: OTP_RESEND_LOCK_MS / 1000 };
  }

  // Step 2: verify the code sent to the new number and, on success, update the
  // user's phone. The request row is consumed so the code can't be reused.
  verifyPhoneChange({ userId, code }: { userId: string; code: string }) {
    const req = db.select().from(phoneChangeRequests)
      .where(eq(phoneChangeRequests.userId, userId)).get() as PhoneChangeRequest | undefined;
    if (!req || req.consumed) return { error: "Запросите код подтверждения заново" };
    if (Date.now() > req.expiresAt) return { error: "Срок действия кода истёк. Запросите новый код" };
    if (req.attempts >= OTP_MAX_ATTEMPTS) return { error: "Слишком много попыток. Запросите новый код" };

    const provided = hashOtp(req.newPhone, code.trim());
    if (!safeEqualHex(provided, req.codeHash)) {
      const attempts = req.attempts + 1;
      db.update(phoneChangeRequests).set({ attempts }).where(eq(phoneChangeRequests.userId, userId)).run();
      const left = OTP_MAX_ATTEMPTS - attempts;
      return {
        error: left > 0 ? `Неверный код. Осталось попыток: ${left}` : "Слишком много попыток. Запросите новый код",
      };
    }

    // Re-check the number is still free (another account could have claimed it
    // between request and verify), then apply the change.
    const taken = db.select().from(users).where(eq(users.phone, req.newPhone)).get() as User | undefined;
    if (taken && taken.id !== userId) {
      return { error: "Этот номер уже используется другим аккаунтом" };
    }

    db.update(phoneChangeRequests).set({ consumed: true }).where(eq(phoneChangeRequests.userId, userId)).run();
    db.update(users).set({ phone: req.newPhone, updatedAt: Date.now() } as any).where(eq(users.id, userId)).run();
    return { user: this.getUser(userId)! };
  }

  // ---------- Payment methods (MVP metadata only) ----------
  listPaymentMethods(userId: string) {
    return db.select().from(paymentMethods)
      .where(eq(paymentMethods.userId, userId))
      .orderBy(desc(paymentMethods.createdAt))
      .all() as PaymentMethod[];
  }

  // Link a method. Label/status are derived server-side so no card data can be
  // injected via the client. A masked test pan is used for "card" — never a
  // real number — and a fixed label for SBP.
  linkPaymentMethod(userId: string, type: "card" | "sbp") {
    const label = type === "card" ? "•••• 4242" : "СБП";
    return db.insert(paymentMethods).values({
      userId, type, label, status: "linked", createdAt: Date.now(),
    }).returning().get() as PaymentMethod;
  }

  unlinkPaymentMethod(userId: string, id: number) {
    const res = db.delete(paymentMethods)
      .where(sql`${paymentMethods.id} = ${id} AND ${paymentMethods.userId} = ${userId}`)
      .run();
    return res.changes > 0;
  }

  // ---------- T-Bank card binding (real acquiring metadata) ----------
  // Create a pending card method when a binding flow starts. The card is not
  // usable until the notification confirms it (status -> active) and fills in
  // CardId/RebillId. No card data is ever stored here.
  createPendingCardMethod(input: { userId: string; customerKey: string; requestKey?: string }) {
    const now = Date.now();
    return db.insert(paymentMethods).values({
      userId: input.userId,
      type: "card",
      label: "Карта (привязывается…)",
      status: "pending",
      provider: "tbank",
      customerKey: input.customerKey,
      requestKey: input.requestKey ?? null,
      createdAt: now,
      updatedAt: now,
    } as any).returning().get() as PaymentMethod;
  }

  // Create a pending card method backed by an Init+Recurrent verification
  // payment (the primary binding path). Stores our OrderId + amount so the
  // notification webhook can correlate the payment back to this row. The card is
  // not usable until the payment is CONFIRMED/AUTHORIZED with a RebillId. No card
  // data is ever stored here — the PAN/CVC live only on T-Bank's hosted form.
  createPendingBindPayment(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    amountKopecks: number;
  }) {
    const now = Date.now();
    return db.insert(paymentMethods).values({
      userId: input.userId,
      type: "card",
      label: "Карта (привязывается…)",
      status: "pending",
      provider: "tbank",
      purpose: "card_binding",
      customerKey: input.customerKey,
      orderId: input.orderId,
      amountKopecks: input.amountKopecks,
      createdAt: now,
      updatedAt: now,
    } as any).returning().get() as PaymentMethod;
  }

  // Create a pending SBP account binding (AddAccountQr). The account is not
  // usable until the payer authorises it in their bank and T-Bank returns an
  // AccountToken (via notification or GetAddAccountQrState). We store the
  // RequestKey + OrderId so either path can correlate back to this row. No
  // account/card data is ever stored — only the opaque provider identifiers.
  createPendingSbpBinding(input: {
    userId: string;
    customerKey: string;
    orderId: string;
    requestKey?: string;
  }) {
    const now = Date.now();
    return db.insert(paymentMethods).values({
      userId: input.userId,
      type: "sbp",
      label: "СБП (привязывается…)",
      status: "pending",
      provider: "tbank",
      purpose: "sbp_binding",
      customerKey: input.customerKey,
      orderId: input.orderId,
      requestKey: input.requestKey ?? null,
      createdAt: now,
      updatedAt: now,
    } as any).returning().get() as PaymentMethod;
  }

  getPaymentMethod(id: number) {
    return db.select().from(paymentMethods).where(eq(paymentMethods.id, id)).get() as
      | PaymentMethod
      | undefined;
  }

  // The most recent pending T-Bank card binding for a user. Used by the
  // notification handler to attach the confirmed card to the binding the rider
  // just started.
  findPendingCardMethod(userId: string) {
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'pending'`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  // Locate a T-Bank card-binding method by the Init OrderId echoed back in the
  // payment notification. This is how the webhook correlates a verification
  // payment to the pending method (the Init flow has no RequestKey).
  findCardMethodByOrderId(orderId: string) {
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.provider} = 'tbank' AND ${paymentMethods.orderId} = ${orderId}`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  // Locate a user's T-Bank card method by its AddCard RequestKey. Used to
  // resolve the method a rider was redirected back from (the Success/Fail URL
  // carries the RequestKey) so we can refresh exactly that binding.
  findCardMethodByRequestKey(userId: string, requestKey: string) {
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.requestKey} = ${requestKey}`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  // Locate any T-Bank method by RequestKey alone (no user scope). The SBP
  // binding notification carries a RequestKey but not our user id, so this is
  // how the webhook attaches the AccountToken to the right pending row.
  findMethodByRequestKey(requestKey: string) {
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.provider} = 'tbank' AND ${paymentMethods.requestKey} = ${requestKey}`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  // Resolve the rider's saved SBP account eligible for a recurring charge: an
  // active sbp-type method with an AccountToken. Mirrors getActiveSavedCard.
  getActiveSavedSbp(userId: string, paymentMethodId?: number) {
    if (paymentMethodId != null) {
      const m = this.getPaymentMethod(paymentMethodId);
      if (!m || m.userId !== userId) return undefined;
      if (m.provider !== "tbank" || m.status !== "active" || !m.accountToken) return undefined;
      return m;
    }
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'active' AND ${paymentMethods.accountToken} IS NOT NULL AND ${paymentMethods.accountToken} != ''`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  updatePaymentMethod(id: number, patch: Partial<PaymentMethod>) {
    const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
    delete set.id;
    db.update(paymentMethods).set(set as any).where(eq(paymentMethods.id, id)).run();
    return this.getPaymentMethod(id);
  }

  // ---------- T-Bank ordinary ride payment orders ----------
  // Create a pending ride payment order when the rider starts the pay-then-ride
  // flow. The ride is NOT started until the payment is confirmed by the
  // notification webhook (status -> paid, ride_id filled). No card data is ever
  // stored here — the PAN/CVC live only on T-Bank's hosted form.
  createRidePaymentOrder(input: {
    orderId: string;
    userId: string;
    bikeId: string;
    tariffId: string;
    amountKopecks: number;
    // "hosted" (default) for the hosted-form path; "saved_card" for a recurring
    // charge against a stored RebillId.
    source?: "hosted" | "saved_card";
    paymentMethodId?: number;
    rebillId?: string;
  }) {
    const now = Date.now();
    return db.insert(paymentOrders).values({
      orderId: input.orderId,
      userId: input.userId,
      bikeId: input.bikeId,
      tariffId: input.tariffId,
      amountKopecks: input.amountKopecks,
      source: input.source ?? "hosted",
      paymentMethodId: input.paymentMethodId ?? null,
      rebillId: input.rebillId ?? null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    } as any).returning().get() as PaymentOrder;
  }

  // Resolve the rider's saved T-Bank card eligible for a recurring charge: an
  // active card-type method with a RebillId. When paymentMethodId is given it
  // must belong to the rider and be active with a RebillId; otherwise the most
  // recent qualifying card is returned. Returns undefined when no usable saved
  // card exists (the caller then falls back to the hosted payment flow).
  getActiveSavedCard(userId: string, paymentMethodId?: number) {
    if (paymentMethodId != null) {
      const m = this.getPaymentMethod(paymentMethodId);
      if (!m || m.userId !== userId) return undefined;
      if (m.provider !== "tbank" || m.status !== "active" || !m.rebillId) return undefined;
      return m;
    }
    return db.select().from(paymentMethods)
      .where(sql`${paymentMethods.userId} = ${userId} AND ${paymentMethods.provider} = 'tbank' AND ${paymentMethods.status} = 'active' AND ${paymentMethods.rebillId} IS NOT NULL AND ${paymentMethods.rebillId} != ''`)
      .orderBy(desc(paymentMethods.createdAt))
      .get() as PaymentMethod | undefined;
  }

  getRidePaymentOrder(orderId: string) {
    return db.select().from(paymentOrders)
      .where(eq(paymentOrders.orderId, orderId))
      .get() as PaymentOrder | undefined;
  }

  updateRidePaymentOrder(id: number, patch: Partial<PaymentOrder>) {
    const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
    delete set.id;
    db.update(paymentOrders).set(set as any).where(eq(paymentOrders.id, id)).run();
    return db.select().from(paymentOrders).where(eq(paymentOrders.id, id)).get() as
      | PaymentOrder
      | undefined;
  }

  // ---------- Support tickets ----------
  listSupportTickets(userId: string) {
    return db.select().from(supportTickets)
      .where(eq(supportTickets.userId, userId))
      .orderBy(desc(supportTickets.createdAt))
      .all() as SupportTicket[];
  }

  createSupportTicket({ userId, subject, message }: { userId: string; subject: string; message: string }) {
    return db.insert(supportTickets).values({
      userId, subject: subject.trim(), message: message.trim(), status: "open", createdAt: Date.now(),
    }).returning().get() as SupportTicket;
  }

  // Public list excludes archived (retired) bikes so they never appear on the
  // map or in rental selection. Admin callers pass includeArchived to see all.
  listBikes(opts?: { includeArchived?: boolean }) {
    const rows = db.select().from(bikes).all() as Bike[];
    if (opts?.includeArchived) return rows;
    return rows.filter((b) => b.status !== "archived");
  }
  getBike(id: string) { return db.select().from(bikes).where(eq(bikes.id, id)).get() as Bike | undefined; }
  updateBike(id: string, patch: Partial<Bike>) {
    db.update(bikes).set(patch as any).where(eq(bikes.id, id)).run();
    return this.getBike(id);
  }

  // ---------- Bikes: admin CRUD (staff only) ----------
  // Normalize an optional string field: trim, and treat "" as null so blank
  // form inputs clear the column rather than storing an empty string.
  private optStr(v: string | undefined): string | null {
    if (v === undefined) return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  }

  // Create a real (non-demo) bike. The id is unique (primary key); a duplicate
  // is rejected with a clear message. Map coordinates default to the assigned
  // parking station or the map centre so the bike has a valid position.
  createBike(input: AdminCreateBikeInput) {
    const id = input.id.trim().toUpperCase();
    if (this.getBike(id)) return { error: "Велосипед с таким кодом уже существует" };

    let lat = MAP_H / 2;
    let lng = MAP_W / 2;
    const parkingId = this.optStr(input.parkingId);
    if (parkingId) {
      const p = db.select().from(parkings).where(eq(parkings.id, parkingId)).get() as Parking | undefined;
      if (p) { lat = p.lat; lng = p.lng; }
    }

    const now = Date.now();
    db.insert(bikes).values({
      id,
      model: input.model.trim(),
      status: input.status,
      battery: input.battery,
      lat, lng,
      lastSeen: now,
      idleHours: 0,
      flagged: false,
      serial: this.optStr(input.serial),
      lockId: this.optStr(input.lockId),
      parkingId,
      notes: this.optStr(input.notes),
      seed: false,
    } as any).run();
    return { bike: this.getBike(id)! };
  }

  adminUpdateBike(id: string, patch: AdminUpdateBikeInput) {
    const existing = this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };

    const set: Partial<Bike> = {};
    if (patch.model !== undefined) set.model = patch.model.trim();
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.battery !== undefined) set.battery = patch.battery;
    if (patch.serial !== undefined) set.serial = this.optStr(patch.serial);
    if (patch.lockId !== undefined) set.lockId = this.optStr(patch.lockId);
    if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);
    if (patch.parkingId !== undefined) {
      const parkingId = this.optStr(patch.parkingId);
      set.parkingId = parkingId;
    }
    db.update(bikes).set(set as any).where(eq(bikes.id, id)).run();
    return { bike: this.getBike(id)! };
  }

  // Soft delete: mark a bike archived so it drops out of the public list and
  // rental selection while keeping its ride history intact.
  archiveBike(id: string) {
    const existing = this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };
    if (existing.status === "rented") return { error: "Нельзя архивировать велосипед во время активной аренды" };
    db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id)).run();
    return { bike: this.getBike(id)! };
  }

  // Hard delete: only allowed when the bike has no ride history. Otherwise we
  // refuse and archive instead, so analytics/ride records never dangle.
  deleteBike(id: string) {
    const existing = this.getBike(id);
    if (!existing) return { error: "Велосипед не найден" };
    if (existing.status === "rented") return { error: "Нельзя удалить велосипед во время активной аренды" };
    const rideCount = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides WHERE bike_id = ?").get(id) as { c: number }).c;
    if (rideCount > 0) {
      db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id)).run();
      return { error: "У велосипеда есть история поездок — он переведён в архив", archived: this.getBike(id)! };
    }
    db.delete(bikes).where(eq(bikes.id, id)).run();
    return { ok: true as const };
  }
  // ---------- Parkings: read + admin CRUD ----------
  // Public callers get active, non-archived points only. The admin page passes
  // includeInactive/includeArchived to see the full set.
  listParkings(opts?: { includeInactive?: boolean; includeArchived?: boolean }) {
    let rows = db.select().from(parkings).all() as Parking[];
    if (!opts?.includeArchived) rows = rows.filter((p) => !p.archivedAt);
    if (!opts?.includeInactive) rows = rows.filter((p) => p.status === "active");
    return rows;
  }
  getParking(id: string) {
    return db.select().from(parkings).where(eq(parkings.id, id)).get() as Parking | undefined;
  }

  // Generate the next free P-NN id when the operator doesn't supply one.
  private nextParkingId(): string {
    const ids = (db.select({ id: parkings.id }).from(parkings).all() as { id: string }[]).map((r) => r.id);
    let n = 1;
    while (ids.includes(`P-${String(n).padStart(2, "0")}`)) n++;
    return `P-${String(n).padStart(2, "0")}`;
  }

  createParking(input: AdminCreateParkingInput) {
    const id = (input.id && input.id.trim().length > 0 ? input.id.trim().toUpperCase() : this.nextParkingId());
    if (this.getParking(id)) return { error: "Парковка с таким кодом уже существует" };
    const now = Date.now();
    const occupied = Math.min(input.occupied, input.capacity);
    db.insert(parkings).values({
      id,
      name: input.name.trim(),
      lat: input.lat,
      lng: input.lng,
      capacity: input.capacity,
      occupied,
      status: input.status,
      notes: this.optStr(input.notes),
      archivedAt: null,
      seed: false,
      createdAt: now,
      updatedAt: now,
    } as any).run();
    return { parking: this.getParking(id)! };
  }

  updateParking(id: string, patch: AdminUpdateParkingInput) {
    const existing = this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    const set: Partial<Parking> = {};
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.lat !== undefined) set.lat = patch.lat;
    if (patch.lng !== undefined) set.lng = patch.lng;
    if (patch.capacity !== undefined) set.capacity = patch.capacity;
    if (patch.occupied !== undefined) set.occupied = patch.occupied;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);
    // Keep occupied within the (possibly new) capacity bound.
    const cap = set.capacity ?? existing.capacity;
    const occ = set.occupied ?? existing.occupied;
    if (occ > cap) set.occupied = cap;
    set.updatedAt = Date.now();
    db.update(parkings).set(set as any).where(eq(parkings.id, id)).run();
    return { parking: this.getParking(id)! };
  }

  // Soft delete: stamp archivedAt so the point drops out of every list while
  // staying referenceable from bikes/history that point at its id.
  archiveParking(id: string) {
    const existing = this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    db.update(parkings).set({ archivedAt: Date.now(), updatedAt: Date.now() } as any).where(eq(parkings.id, id)).run();
    return { parking: this.getParking(id)! };
  }

  // Undo a soft delete: clear archivedAt and force status to inactive so the
  // point returns muted on the admin maps but never re-appears on the public
  // map until an operator explicitly re-activates it.
  restoreParking(id: string) {
    const existing = this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    if (!existing.archivedAt) return { error: "Парковка не в архиве" };
    db.update(parkings).set({ archivedAt: null, status: "inactive", updatedAt: Date.now() } as any).where(eq(parkings.id, id)).run();
    return { parking: this.getParking(id)! };
  }

  // Hard delete: only when no bike references this parking. Otherwise archive so
  // bike.parkingId never dangles.
  deleteParking(id: string) {
    const existing = this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    const refCount = (sqlite.prepare("SELECT COUNT(*) AS c FROM bikes WHERE parking_id = ?").get(id) as { c: number }).c;
    if (refCount > 0) {
      db.update(parkings).set({ archivedAt: Date.now(), updatedAt: Date.now() } as any).where(eq(parkings.id, id)).run();
      return { error: "К парковке привязаны велосипеды — она переведена в архив", archived: this.getParking(id)! };
    }
    db.delete(parkings).where(eq(parkings.id, id)).run();
    return { ok: true as const };
  }

  listZones() { return db.select().from(zones).all() as ZoneRow[]; }

  startRide({ bikeId, userId, tariff, prepaid }: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }) {
    // Hourly, prepaid model: the rider picks an hourly tariff (h1/h2/h3) and
    // pays its full price UP FRONT. The ride's cost is fixed to the tariff
    // price at start (in kopecks); endRide only adds an overage charge if the
    // rider exceeds the paid window (auto-extension). There is no per-minute
    // accrual any more.
    //
    // Two payment paths:
    //   - prepaid = true  -> the rider already paid on T-Bank's hosted/recurring
    //     flow (ride/init). The wallet must NOT be charged again here.
    //   - prepaid = false -> internal/demo flow: charge the tariff price from
    //     the wallet balance atomically as part of starting the ride.
    const tariffDef = TARIFFS.find((t) => t.id === tariff);
    const costKopecks = tariffDef ? tariffPriceKopecks(tariffDef) : 0;

    // Atomic: re-check the bike/rider state and claim the bike inside ONE
    // transaction. Without this, two concurrent requests could both pass the
    // availability/active-ride checks and each insert a ride for the same bike
    // (double-booking). The transaction serialises the check-and-claim so the
    // second caller sees the bike already "rented" / the rider already riding.
    return db.transaction((tx) => {
      const bike = tx.select().from(bikes).where(eq(bikes.id, bikeId)).get() as Bike | undefined;
      if (!bike) return { error: "Велосипед не найден" };
      if (bike.status !== "available" && bike.status !== "reserved") {
        return { error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` };
      }
      if (bike.battery < 18) return { error: "Низкий заряд замка, выберите другой велосипед" };
      const active = tx.select().from(rides)
        .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
        .get() as Ride | undefined;
      if (active) return { error: "У вас уже есть активная поездка" };

      // Internal (non-prepaid) flow: debit the tariff price from the wallet up
      // front, inside the same transaction so a failure rolls the ride back.
      if (!prepaid && costKopecks > 0) {
        let w = tx.select().from(wallet).where(eq(wallet.userId, userId)).get() as Wallet | undefined;
        if (!w) {
          tx.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any).run();
          w = { userId, balance: 0 } as Wallet;
        }
        if (w.balance < costKopecks) {
          return { error: "Недостаточно средств на балансе" };
        }
        tx.update(wallet).set({ balance: w.balance - costKopecks }).where(eq(wallet.userId, userId)).run();
        tx.insert(payments).values({
          userId, amount: -costKopecks, kind: "ride_charge",
          description: `Аренда ${bikeId} • ${tariffDef?.name ?? tariff}`, createdAt: Date.now(),
        }).run();
      }

      const startedAt = Date.now();
      const track: [number, number, number][] = [[bike.lng, bike.lat, startedAt]];
      const row = tx.insert(rides).values({
        bikeId, userId, startedAt,
        startLat: bike.lat, startLng: bike.lng,
        track: JSON.stringify(track), distanceM: 0, cost: costKopecks, tariff, status: "active",
      }).returning().get() as Ride;
      tx.update(bikes).set({ status: "rented", updatedAt: Date.now() } as any)
        .where(eq(bikes.id, bikeId)).run();
      return row;
    });
  }

  appendRidePoint(rideId: number, x: number, y: number) {
    const r = db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride | undefined;
    if (!r || r.status !== "active") return undefined;
    const pts: [number, number, number][] = JSON.parse(r.track);
    const last = pts[pts.length - 1];
    const dx = x - last[0], dy = y - last[1];
    const dMap = Math.sqrt(dx * dx + dy * dy);
    // 1 map unit ≈ 30 metres (≈30km coastal span across 1000 units, demo scale)
    const addedMeters = dMap * 30;
    pts.push([x, y, Date.now()]);
    const newDistance = r.distanceM + addedMeters;
    // Hourly prepaid model: cost is fixed at start (tariff price) and only
    // changes on overage in endRide. Live points update the track/distance
    // only — never the price.
    db.update(rides).set({
      track: JSON.stringify(pts), distanceM: newDistance,
    }).where(eq(rides.id, rideId)).run();
    db.update(bikes).set({ lat: y, lng: x, lastSeen: Date.now(), idleHours: 0 } as any)
      .where(eq(bikes.id, r.bikeId)).run();
    return db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride;
  }

  endRide(rideId: number) {
    // Atomic: completing a ride touches four tables (ride, bike, wallet,
    // payment ledger). Doing them as separate statements risks a partial state
    // if the process dies mid-way — e.g. wallet debited but ride still active,
    // or bike freed without a charge recorded. One transaction keeps them
    // consistent: either the whole settlement lands or none of it does.
    return db.transaction((tx) => {
      const r = tx.select().from(rides).where(eq(rides.id, rideId)).get() as Ride | undefined;
      if (!r || r.status !== "active") return undefined;
      const pts: [number, number, number][] = JSON.parse(r.track);
      const last = pts[pts.length - 1];
      const endedAt = Date.now();

      // Hourly prepaid model. The tariff was paid at start (r.cost holds the
      // prepaid tariff price, in kopecks). If the rider kept the bike past the
      // paid window, auto-extend by charging one OVERAGE_HOUR_PRICE per started
      // extra hour. Rides on an unknown/legacy tariff (durationHours unknown)
      // skip overage and just settle at the recorded cost.
      const tariffDef = TARIFFS.find((t) => t.id === r.tariff);
      const paidMs = (tariffDef?.durationHours ?? 0) * 60 * 60 * 1000;
      const usedMs = endedAt - r.startedAt;
      const { extraHours, overageKopecks } = computeOverage(usedMs, paidMs);
      const finalCost = finalRideCost(r.cost, overageKopecks);

      tx.update(rides).set({
        endedAt, status: "completed", cost: finalCost,
        endLat: last[1], endLng: last[0],
      }).where(eq(rides.id, rideId)).run();
      tx.update(bikes).set({ status: "available", lat: last[1], lng: last[0], lastSeen: endedAt, idleHours: 0 } as any)
        .where(eq(bikes.id, r.bikeId)).run();

      // Only the overage is charged at end — the base tariff was already paid at
      // start (wallet debit or T-Bank). Debit the wallet for the extra hours,
      // inside the same tx so it rolls back with everything else on failure.
      if (overageKopecks > 0) {
        let w = tx.select().from(wallet).where(eq(wallet.userId, r.userId)).get() as Wallet | undefined;
        if (!w) {
          tx.insert(wallet).values({ userId: r.userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any).run();
          w = { userId: r.userId, balance: 0 } as Wallet;
        }
        tx.update(wallet).set({ balance: w.balance - overageKopecks }).where(eq(wallet.userId, r.userId)).run();
        tx.insert(payments).values({
          userId: r.userId, amount: -overageKopecks, kind: "ride_charge",
          description: `Продление аренды ${r.bikeId} • +${extraHours} ч`, createdAt: endedAt,
        }).run();
      }
      return tx.select().from(rides).where(eq(rides.id, rideId)).get() as Ride;
    });
  }

  getRide(rideId: number) {
    return db.select().from(rides).where(eq(rides.id, rideId)).get() as Ride | undefined;
  }

  getActiveRide(userId: string) {
    return db.select().from(rides)
      .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
      .get() as Ride | undefined;
  }

  listRides(opts?: { userId?: string; limit?: number }) {
    const limit = opts?.limit ?? 50;
    if (opts?.userId) {
      return db.select().from(rides)
        .where(eq(rides.userId, opts.userId))
        .orderBy(desc(rides.startedAt))
        .limit(limit)
        .all() as Ride[];
    }
    return db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit).all() as Ride[];
  }

  // Rides for the operator panel, newest first, joined to rider identity so the
  // admin table can show a name/phone instead of a raw user id. Riders are
  // looked up in a single batch; unknown/demo ids resolve to null so the UI can
  // fall back to the id.
  listAdminRides(opts?: { limit?: number }) {
    const limit = opts?.limit ?? 200;
    const rows = db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit).all() as Ride[];
    const all = db.select().from(users).all() as User[];
    const byId = new Map(all.map((u) => [u.id, u]));
    return rows.map((r) => {
      const u = byId.get(r.userId);
      return { ...r, userName: u?.name ?? null, userPhone: u?.phone ?? null } as AdminRide;
    });
  }

  getWallet(userId: string) {
    let w = db.select().from(wallet).where(eq(wallet.userId, userId)).get() as Wallet | undefined;
    if (!w) {
      db.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any).run();
      w = db.select().from(wallet).where(eq(wallet.userId, userId)).get() as Wallet;
    }
    return w;
  }

  topUp(userId: string, amount: number) {
    const w = this.getWallet(userId);
    const newBal = w.balance + amount;
    db.update(wallet).set({ balance: newBal }).where(eq(wallet.userId, userId)).run();
    const pay = db.insert(payments).values({
      userId, amount, kind: "topup",
      description: `Пополнение баланса карты •• 4242`, createdAt: Date.now(),
    }).returning().get() as Payment;
    return { wallet: this.getWallet(userId), payment: pay };
  }

  purchaseTariff(userId: string, tariff: string, price: number, durationMs: number) {
    const w = this.getWallet(userId);
    const newBal = w.balance - price;
    const expires = Date.now() + durationMs;
    db.update(wallet).set({ balance: newBal, activeTariff: tariff, tariffExpiresAt: expires } as any)
      .where(eq(wallet.userId, userId)).run();
    const pay = db.insert(payments).values({
      userId, amount: -price, kind: "tariff_purchase",
      description: `Подключён тариф «${tariff}»`, createdAt: Date.now(),
    }).returning().get() as Payment;
    return { wallet: this.getWallet(userId), payment: pay };
  }

  listPayments(userId: string) {
    return db.select().from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt))
      .all() as Payment[];
  }

  listTickets() { return db.select().from(tickets).orderBy(desc(tickets.createdAt)).all() as Ticket[]; }

  getTicket(id: number): TicketWithComments | undefined {
    const t = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!t) return undefined;
    const comments = db.select().from(ticketComments)
      .where(eq(ticketComments.ticketId, id))
      .orderBy(ticketComments.createdAt)
      .all() as TicketComment[];
    return { ...t, comments };
  }

  private addEvent(ticketId: number, author: string, body: string, kind: "comment" | "event") {
    db.insert(ticketComments).values({
      ticketId, author, body, kind, createdAt: Date.now(),
    }).run();
  }

  createTicket(input: CreateTicketInput): TicketWithComments {
    const now = Date.now();
    const title = (input.title ?? "").trim();
    const assignee = (input.assignee ?? "").trim();
    const row = db.insert(tickets).values({
      bikeId: input.bikeId,
      kind: input.kind,
      priority: input.priority,
      title,
      message: input.message,
      assignee: assignee || null,
      status: "new",
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    }).returning().get() as Ticket;
    this.addEvent(row.id, "Система", "Заявка создана", "event");

    // High/critical tickets pull a rentable bike out of rotation into
    // maintenance so it can't be rented while the issue is open. We never touch
    // a bike that's mid-ride (rented) or already out of service.
    if ((input.priority === "high" || input.priority === "critical")) {
      const bike = this.getBike(input.bikeId);
      if (bike && (bike.status === "available" || bike.status === "reserved")) {
        this.updateBike(bike.id, { status: "maintenance" });
        this.addEvent(row.id, "Система", `Велосипед ${bike.id} переведён в обслуживание`, "event");
      }
    }
    return this.getTicket(row.id)!;
  }

  updateTicket(id: number, patch: UpdateTicketInput, actor: string): TicketWithComments | undefined {
    const existing = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!existing) return undefined;
    const now = Date.now();
    const set: Partial<Ticket> = { updatedAt: now };

    if (patch.priority !== undefined && patch.priority !== existing.priority) {
      set.priority = patch.priority;
      this.addEvent(id, actor, `Приоритет: ${existing.priority} → ${patch.priority}`, "event");
    }
    if (patch.assignee !== undefined) {
      const next = patch.assignee.trim() || null;
      if (next !== (existing.assignee ?? null)) {
        set.assignee = next;
        this.addEvent(id, actor, next ? `Назначено: ${next}` : "Исполнитель снят", "event");
      }
    }
    if (patch.status !== undefined && patch.status !== existing.status) {
      set.status = patch.status;
      const becameClosed = TICKET_CLOSED_STATUSES.includes(patch.status);
      set.closedAt = becameClosed ? now : null;
      this.addEvent(id, actor, `Статус: ${existing.status} → ${patch.status}`, "event");
    }

    db.update(tickets).set(set as any).where(eq(tickets.id, id)).run();

    // Optional action when closing: return the bike to the rental pool if it's
    // currently in maintenance because of this issue.
    if (patch.returnBikeToAvailable) {
      const bike = this.getBike(existing.bikeId);
      if (bike && bike.status === "maintenance") {
        this.updateBike(bike.id, { status: "available" });
        this.addEvent(id, actor, `Велосипед ${bike.id} возвращён в доступные`, "event");
      }
    }
    return this.getTicket(id);
  }

  addTicketComment(id: number, author: string, body: string): TicketWithComments | undefined {
    const existing = db.select().from(tickets).where(eq(tickets.id, id)).get() as Ticket | undefined;
    if (!existing) return undefined;
    this.addEvent(id, author, body, "comment");
    db.update(tickets).set({ updatedAt: Date.now() }).where(eq(tickets.id, id)).run();
    return this.getTicket(id);
  }

  listMapObjects(opts?: { activeOnly?: boolean }) {
    const rows = db.select().from(mapObjects).orderBy(desc(mapObjects.createdAt)).all() as MapObject[];
    return opts?.activeOnly ? rows.filter((o) => o.active) : rows;
  }

  createMapObject(input: InsertMapObject) {
    return db.insert(mapObjects).values({
      name: input.name,
      type: input.type,
      kind: input.kind,
      color: input.color,
      points: JSON.stringify(input.points),
      active: input.active,
      createdAt: Date.now(),
    }).returning().get() as MapObject;
  }

  setMapObjectActive(id: number, active: boolean) {
    db.update(mapObjects).set({ active } as any).where(eq(mapObjects.id, id)).run();
    return db.select().from(mapObjects).where(eq(mapObjects.id, id)).get() as MapObject | undefined;
  }

  deleteMapObject(id: number) {
    const res = db.delete(mapObjects).where(eq(mapObjects.id, id)).run();
    return res.changes > 0;
  }

  analytics() {
    const total = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides").get() as any).c;
    const completed = (sqlite.prepare("SELECT COUNT(*) AS c FROM rides WHERE status='completed'").get() as any).c;
    const revenue = (sqlite.prepare("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed'").get() as any).s;
    const avgDuration = (sqlite.prepare("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed'").get() as any).a;
    const avgDistance = (sqlite.prepare("SELECT COALESCE(AVG(distance_m),0) AS a FROM rides WHERE status='completed'").get() as any).a;

    const byDay = sqlite.prepare(`
      SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
             COUNT(*) AS rides_count,
             COALESCE(SUM(cost),0) AS revenue
      FROM rides
      GROUP BY day
      ORDER BY day DESC
      LIMIT 14
    `).all().reverse();

    // popular parkings — proximity of ride start
    const allParkings = this.listParkings();
    const allRides = sqlite.prepare("SELECT start_lat, start_lng FROM rides").all() as any[];
    const parkingCounts = allParkings.map(p => {
      let c = 0;
      for (const r of allRides) {
        const dx = r.start_lng - p.lng;
        const dy = r.start_lat - p.lat;
        if (Math.sqrt(dx*dx+dy*dy) < 30) c++;
      }
      return { ...p, rideStarts: c };
    }).sort((a, b) => b.rideStarts - a.rideStarts);

    const utilisation = sqlite.prepare(`
      SELECT bike_id, COUNT(*) AS rides
      FROM rides
      GROUP BY bike_id
      ORDER BY rides DESC
      LIMIT 8
    `).all();

    const problemBikes = sqlite.prepare(`
      SELECT * FROM bikes
      WHERE flagged = 1 OR battery < 25 OR idle_hours > 60
      ORDER BY idle_hours DESC
      LIMIT 12
    `).all();

    const idleAvg = (sqlite.prepare("SELECT AVG(idle_hours) AS a FROM bikes").get() as any).a;

    return { total, completed, revenue, avgDuration, avgDistance, byDay, parkingCounts, utilisation, problemBikes, idleAvg };
  }

  // Period-scoped analytics powering the admin "Аналитика v1" page. Everything
  // is computed against rides that *started* within [from, to]. Revenue is the
  // sum of settled ride cost (the current ride/tariff data — no real acquiring).
  adminAnalytics(range: { from: number; to: number }) {
    const { from, to } = range;
    const q = (sqlStr: string) =>
      sqlite.prepare(sqlStr).get(from, to) as any;

    // ---- KPI cards (selected period) ----
    const ridesCount = q("SELECT COUNT(*) AS c FROM rides WHERE started_at >= ? AND started_at <= ?").c;
    const activeRides = q("SELECT COUNT(*) AS c FROM rides WHERE status='active' AND started_at >= ? AND started_at <= ?").c;
    const completedRides = q("SELECT COUNT(*) AS c FROM rides WHERE status='completed' AND started_at >= ? AND started_at <= ?").c;
    const revenue = q("SELECT COALESCE(SUM(cost),0) AS s FROM rides WHERE status='completed' AND started_at >= ? AND started_at <= ?").s;
    const avgDuration = q("SELECT COALESCE(AVG((ended_at-started_at)/60000.0),0) AS a FROM rides WHERE status='completed' AND ended_at IS NOT NULL AND started_at >= ? AND started_at <= ?").a;
    // Average check = revenue per completed (paid) ride in the period.
    const avgCheck = completedRides > 0 ? revenue / completedRides : 0;
    const newUsers = q("SELECT COUNT(*) AS c FROM users WHERE created_at >= ? AND created_at <= ?").c;
    const usersWithRides = q("SELECT COUNT(DISTINCT user_id) AS c FROM rides WHERE started_at >= ? AND started_at <= ?").c;
    const openTickets = (sqlite.prepare(
      `SELECT COUNT(*) AS c FROM tickets WHERE status NOT IN ('resolved','closed','cancelled')`,
    ).get() as any).c;

    // ---- Rides per day (within the period) for the trend chart ----
    const byDay = sqlite.prepare(`
      SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch') AS day,
             COUNT(*) AS rides_count,
             COALESCE(SUM(CASE WHEN status='completed' THEN cost ELSE 0 END),0) AS revenue
      FROM rides
      WHERE started_at >= ? AND started_at <= ?
      GROUP BY day
      ORDER BY day ASC
    `).all(from, to) as any[];

    // ---- Top bikes (most rides) and zero-ride bikes in the period ----
    const ridesByBike = new Map<string, number>();
    for (const row of sqlite.prepare(
      "SELECT bike_id, COUNT(*) AS c FROM rides WHERE started_at >= ? AND started_at <= ? GROUP BY bike_id",
    ).all(from, to) as any[]) {
      ridesByBike.set(row.bike_id, row.c);
    }
    const liveBikes = this.listBikes(); // excludes archived
    const topBikes = liveBikes
      .map((b) => ({ id: b.id, model: b.model, status: b.status, rides: ridesByBike.get(b.id) ?? 0 }))
      .sort((a, b) => b.rides - a.rides)
      .slice(0, 10);
    const zeroRideBikes = liveBikes
      .filter((b) => (ridesByBike.get(b.id) ?? 0) === 0)
      .map((b) => ({ id: b.id, model: b.model, status: b.status, idleHours: b.idleHours }))
      .sort((a, b) => b.idleHours - a.idleHours);

    // ---- Users summary ----
    const totalUsers = (sqlite.prepare("SELECT COUNT(*) AS c FROM users").get() as any).c;
    const blockedUsers = (sqlite.prepare("SELECT COUNT(*) AS c FROM users WHERE blocked_at IS NOT NULL").get() as any).c;
    const usersSummary = { total: totalUsers, newInPeriod: newUsers, withRidesInPeriod: usersWithRides, blocked: blockedUsers };

    // ---- Service stats (whole-fleet snapshot; tickets are operational, not period-bound) ----
    const ticketsByPriority = sqlite.prepare(
      "SELECT priority, COUNT(*) AS c FROM tickets GROUP BY priority",
    ).all() as any[];
    const ticketsByStatus = sqlite.prepare(
      "SELECT status, COUNT(*) AS c FROM tickets GROUP BY status",
    ).all() as any[];
    const ticketsByKind = sqlite.prepare(
      "SELECT kind, COUNT(*) AS c FROM tickets GROUP BY kind ORDER BY c DESC",
    ).all() as any[];
    // Repeated-problem bikes: more than one ticket ever logged against them.
    const repeatedProblemBikes = sqlite.prepare(`
      SELECT bike_id, COUNT(*) AS tickets,
             SUM(CASE WHEN status NOT IN ('resolved','closed','cancelled') THEN 1 ELSE 0 END) AS open
      FROM tickets
      GROUP BY bike_id
      HAVING COUNT(*) > 1
      ORDER BY tickets DESC
      LIMIT 12
    `).all() as any[];

    // ---- Parking usage (proximity of ride starts in the period) ----
    const periodStarts = sqlite.prepare(
      "SELECT start_lat, start_lng FROM rides WHERE started_at >= ? AND started_at <= ?",
    ).all(from, to) as any[];
    const parkingUsage = this.listParkings().map((p) => {
      let c = 0;
      for (const r of periodStarts) {
        const dx = r.start_lng - p.lng;
        const dy = r.start_lat - p.lat;
        if (Math.sqrt(dx * dx + dy * dy) < 30) c++;
      }
      return { id: p.id, name: p.name, capacity: p.capacity, occupied: p.occupied, rideStarts: c };
    }).sort((a, b) => b.rideStarts - a.rideStarts);

    return {
      range: { from, to },
      kpis: {
        ridesCount,
        activeRides,
        completedRides,
        revenue,
        avgDurationMin: avgDuration,
        avgCheck,
        newUsers,
        usersWithRides,
        openTickets,
      },
      byDay,
      topBikes,
      zeroRideBikes,
      usersSummary,
      service: {
        byPriority: ticketsByPriority,
        byStatus: ticketsByStatus,
        byKind: ticketsByKind,
        repeatedProblemBikes,
      },
      parkingUsage,
    };
  }
}

export const storage = new DatabaseStorage();

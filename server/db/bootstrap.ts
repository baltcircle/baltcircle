// ---------- Database client + schema bootstrap + demo seed (PostgreSQL) ----------
// Owns the single pg connection pool, the CREATE TABLE bootstrap, performance
// indexes, and the demo-data seed. Unlike the old SQLite module (which ran
// synchronously at import time), Postgres I/O is async: bootstrap runs inside
// `bootstrapReady`, a promise the server MUST await before serving requests.
//
// The historical in-place SQLite column migrations (PRAGMA table_info + ALTER)
// are gone: they existed to patch older prototype SQLite files in place. The
// Postgres schema is created complete from the start; real production rows are
// brought over once by the standalone data-migration script (scripts/migrate-
// sqlite-to-pg.ts), not by this bootstrap.
import {
  PARKINGS, OPERATING_ZONE, SLOW_ZONES, FORBIDDEN_ZONES,
  TARIFFS, tariffPriceKopecks,
} from "@shared/geo";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const { Pool } = pg;

// unix-ms timestamps and kopecks amounts are plain JS numbers in the app, so
// tell node-postgres to parse Postgres BIGINT (OID 20) as a Number instead of a
// string. Every bigint we store (Date.now(), kopecks) is well within
// Number.MAX_SAFE_INTEGER, so this is lossless for this workload.
pg.types.setTypeParser(20, (val) => (val === null ? null : Number(val)));

const connectionString =
  process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5433/baltcircle";

// A single shared pool for the whole process. max is generous enough for the
// concurrent ride/payment/session load at 300 bikes but bounded so a burst
// can't exhaust the managed-Postgres connection limit.
export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db = drizzle(pool);

// ---------- Schema bootstrap ----------
// Every table carries its full current column set. serial for autoincrement
// PKs, bigint for unix-ms timestamps + kopecks, double precision for map
// coordinates, boolean for flags. All CREATE ... IF NOT EXISTS so re-running on
// an already-migrated database is a safe no-op.
async function createSchema() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS bikes (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  battery INTEGER NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  last_seen BIGINT NOT NULL,
  idle_hours DOUBLE PRECISION NOT NULL,
  flagged BOOLEAN NOT NULL DEFAULT FALSE,
  serial TEXT,
  lock_id TEXT,
  parking_id TEXT,
  notes TEXT,
  seed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS parkings (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  capacity INTEGER NOT NULL, occupied INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  archived_at BIGINT,
  seed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT,
  updated_at BIGINT
);
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL, polygon TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rides (
  id SERIAL PRIMARY KEY,
  bike_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  start_lat DOUBLE PRECISION NOT NULL,
  start_lng DOUBLE PRECISION NOT NULL,
  end_lat DOUBLE PRECISION, end_lng DOUBLE PRECISION,
  track TEXT NOT NULL,
  distance_m DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  tariff TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  bike_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  assignee TEXT,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT,
  closed_at BIGINT
);
CREATE TABLE IF NOT EXISTS ticket_comments (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'comment',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet (
  user_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  active_tariff TEXT NOT NULL DEFAULT 'payg',
  tariff_expires_at BIGINT
);
CREATE TABLE IF NOT EXISTS map_objects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#1d6f8e',
  points TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  email_verified_at BIGINT,
  role TEXT NOT NULL DEFAULT 'rider',
  consent_accepted_at BIGINT,
  consent_version TEXT,
  consent_ip TEXT,
  blocked_at BIGINT,
  blocked_reason TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);
CREATE TABLE IF NOT EXISTS otp_requests (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at BIGINT NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT FALSE,
  provider TEXT,
  provider_message_id TEXT,
  provider_status TEXT,
  provider_error TEXT,
  provider_checked_at BIGINT
);
CREATE TABLE IF NOT EXISTS phone_change_requests (
  user_id TEXT PRIMARY KEY,
  new_phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at BIGINT NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS email_change_requests (
  user_id TEXT PRIMARY KEY,
  new_email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at BIGINT NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS oauth_identities (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at BIGINT NOT NULL,
  last_success_at BIGINT
);
CREATE TABLE IF NOT EXISTS payment_methods (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  brand TEXT,
  status TEXT NOT NULL DEFAULT 'linked',
  provider TEXT,
  customer_key TEXT,
  card_id TEXT,
  rebill_id TEXT,
  request_key TEXT,
  account_token TEXT,
  purpose TEXT,
  order_id TEXT,
  payment_id TEXT,
  payment_url TEXT,
  amount_kopecks INTEGER,
  refund_status TEXT,
  refund_error TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  last_error_details TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_orders (
  id SERIAL PRIMARY KEY,
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
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);
CREATE TABLE IF NOT EXISTS ride_points (
  id SERIAL PRIMARY KEY,
  ride_id INTEGER NOT NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  t BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_conversations (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  last_message_at BIGINT,
  user_unread_count INTEGER NOT NULL DEFAULT 0,
  operator_unread_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL,
  sender_id TEXT,
  body TEXT NOT NULL DEFAULT '',
  attachment_url TEXT,
  attachment_mime TEXT,
  read_at BIGINT,
  created_at BIGINT NOT NULL
);
`);
}

// ---------- Performance indexes ----------
// Same hot-path indexes as the SQLite build. IF NOT EXISTS keeps re-runs safe.
async function createIndexes() {
  await pool.query(`
CREATE INDEX IF NOT EXISTS idx_rides_user_status ON rides (user_id, status);
CREATE INDEX IF NOT EXISTS idx_rides_user ON rides (user_id);
CREATE INDEX IF NOT EXISTS idx_rides_bike ON rides (bike_id);
CREATE INDEX IF NOT EXISTS idx_rides_started ON rides (started_at);
CREATE INDEX IF NOT EXISTS idx_ride_points_ride ON ride_points (ride_id, id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users (phone);
CREATE INDEX IF NOT EXISTS idx_bikes_status ON bikes (status);
CREATE INDEX IF NOT EXISTS idx_pm_user ON payment_methods (user_id);
CREATE INDEX IF NOT EXISTS idx_pm_user_provider_status ON payment_methods (user_id, provider, status);
CREATE INDEX IF NOT EXISTS idx_pm_order ON payment_methods (order_id);
CREATE INDEX IF NOT EXISTS idx_pm_request_key ON payment_methods (request_key);
CREATE INDEX IF NOT EXISTS idx_po_order ON payment_orders (order_id);
CREATE INDEX IF NOT EXISTS idx_po_user ON payment_orders (user_id);
CREATE INDEX IF NOT EXISTS idx_po_payment ON payment_orders (payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_bike ON tickets (bike_id);
CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket ON ticket_comments (ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets (user_id);
CREATE INDEX IF NOT EXISTS idx_support_conv_user ON support_conversations (user_id);
CREATE INDEX IF NOT EXISTS idx_support_conv_last ON support_conversations (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_msg_conv ON support_messages (conversation_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_provider_subject ON oauth_identities (provider, subject);
CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_identities (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);
`);
}

// ---------- Column migrations for existing databases ----------
// `CREATE TABLE IF NOT EXISTS` doesn't add columns to a pre-existing table, so
// any new column must be applied here with `ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS`. Idempotent — safe to run on every boot.
async function runMigrations() {
  await pool.query(`
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;
`);
}

const MODELS = ["BC Cruiser", "BC Comfort", "BC City+", "BC Lite"];

// Bump this whenever the demo geography/seed data changes so existing databases
// get refreshed automatically on next startup (MVP demo data — safe to wipe &
// reseed, it carries no real user data).
const DEMO_DATA_VERSION = 4;

// Demo fleet size — kept small so QR/rental + admin tables have data without
// flooding the map/tables.
const DEMO_BIKE_COUNT = 5;

function seedRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// Insert the full demo dataset. Runs inside a single client transaction so the
// server only ever sees an empty or a fully-seeded set of demo tables.
async function populateDemoData(client: pg.PoolClient) {
  const rng = seedRng(20260525);
  const now = Date.now();

  // Bikes — a small sample fleet placed near parkings, all "available".
  for (let i = 1; i <= DEMO_BIKE_COUNT; i++) {
    const id = `BC-${String(i).padStart(3, "0")}`;
    const model = MODELS[i % MODELS.length];
    const p = PARKINGS[i % PARKINGS.length];
    const x = p.x + (rng() - 0.5) * 18;
    const y = p.y + (rng() - 0.5) * 18;
    const battery = Math.max(45, Math.min(100, Math.round(60 + rng() * 40)));
    const idleHours = +(rng() * 6).toFixed(1);
    const lastSeen = now - Math.round(idleHours * 3600 * 1000);
    await client.query(
      `INSERT INTO bikes (id, model, status, battery, lat, lng, last_seen, idle_hours, flagged, parking_id, seed)
       VALUES ($1,$2,'available',$3,$4,$5,$6,$7,FALSE,$8,TRUE)`,
      [id, model, battery, y, x, lastSeen, idleHours, p.id],
    );
  }

  // Parkings — seeded active and marked seed = TRUE.
  for (const p of PARKINGS) {
    const occupied = Math.min(p.capacity, Math.floor(rng() * p.capacity * 0.9));
    await client.query(
      `INSERT INTO parkings (id, name, lat, lng, capacity, occupied, status, notes, archived_at, seed, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',NULL,NULL,TRUE,$7,NULL)`,
      [p.id, p.name, p.y, p.x, p.capacity, occupied, now],
    );
  }

  // Zones
  await client.query("INSERT INTO zones (id, name, kind, polygon) VALUES ($1,$2,$3,$4)", [
    "Z-OP", "Зона обслуживания побережья", "operating", JSON.stringify(OPERATING_ZONE),
  ]);
  for (const s of SLOW_ZONES) {
    await client.query("INSERT INTO zones (id, name, kind, polygon) VALUES ($1,$2,'slow',$3)", [
      s.id, s.name, JSON.stringify(s.polygon),
    ]);
  }
  for (const f of FORBIDDEN_ZONES) {
    await client.query("INSERT INTO zones (id, name, kind, polygon) VALUES ($1,$2,'forbidden',$3)", [
      f.id, f.name, JSON.stringify(f.polygon),
    ]);
  }

  // Wallet — single demo user, seeded with a top-up so the MVP is exercisable.
  await client.query(
    "INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at) VALUES ('demo', 50000, 'h2', NULL)",
  );

  // Sample maintenance tickets against seeded bikes.
  const bikeRows = await client.query<{ id: string }>("SELECT id FROM bikes ORDER BY id");
  const sampleBikeIds = bikeRows.rows;
  const insertT = (
    bikeId: string, kind: string, priority: string, title: string, message: string,
    assignee: string | null, status: string, createdAt: number, updatedAt: number | null, closedAt: number | null,
  ) =>
    client.query(
      `INSERT INTO tickets (bike_id, kind, priority, title, message, assignee, status, created_at, updated_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [bikeId, kind, priority, title, message, assignee, status, createdAt, updatedAt, closedAt],
    );
  if (sampleBikeIds[0]) await insertT(sampleBikeIds[0].id, "wheel_puncture", "high", "Спущено колесо", "Пользователь сообщил: спущено заднее колесо", null, "new", now - 5400000, null, null);
  if (sampleBikeIds[1]) await insertT(sampleBikeIds[1].id, "lock", "critical", "Не фиксируется замок", "Пользователь сообщил: не фиксируется замок", "Сервисная бригада", "in_progress", now - 86400000, now - 80000000, null);
  if (sampleBikeIds[2]) await insertT(sampleBikeIds[2].id, "dirty", "low", "Грязный велосипед", "Требуется мойка после поездки в дождь", null, "resolved", now - 172800000, now - 90000000, now - 90000000);

  // Baseline payments + rides for analytics.
  await client.query(
    "INSERT INTO payments (user_id, amount, kind, description, created_at) VALUES ('demo', 50000, 'topup', $1, $2)",
    ["Пополнение через банковскую карту •• 4242", now - 86400000 * 6],
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
      trackPts.push([x, y, startedAt + duration * t]);
    }
    const distance = Math.floor(800 + rng() * 5200);
    const seedTariff = TARIFFS[0]; // h1 — demo rides fit inside one hour
    const cost = tariffPriceKopecks(seedTariff);
    await client.query(
      `INSERT INTO rides (bike_id, user_id, started_at, ended_at, start_lat, start_lng, end_lat, end_lng, track, distance_m, cost, tariff, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'completed')`,
      [bikeId, user, startedAt, endedAt, sp.y, sp.x, ep.y, ep.x, JSON.stringify(trackPts), distance, cost, seedTariff.id],
    );
  }
}

// Seed demo data on a fresh DB, or refresh stale/legacy demo data on an existing
// one. Operator-added bikes (seed = FALSE) and their rides/tickets are always
// preserved; only demo (seed) rows are cleared and reseeded.
async function bootstrapDemoData() {
  // Skip demo seeding when importing legacy production data — the migration
  // brings its own bikes/rides/etc. and demo rows would collide on serial ids.
  if (process.env.SKIP_DEMO_SEED === "1") return;
  const bikeCount = Number(
    (await pool.query<{ c: string }>("SELECT COUNT(*)::int AS c FROM bikes")).rows[0].c,
  );

  const client = await pool.connect();
  try {
    if (bikeCount === 0) {
      await client.query("BEGIN");
      await populateDemoData(client);
      await client.query(
        "INSERT INTO meta (key, value) VALUES ('demo_data_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [String(DEMO_DATA_VERSION)],
      );
      await client.query("COMMIT");
      return;
    }

    // Existing DB: decide whether a reseed is needed.
    const verRow = (
      await client.query<{ value: string }>("SELECT value FROM meta WHERE key = 'demo_data_version'")
    ).rows[0];
    const storedVersion = verRow ? parseInt(verRow.value, 10) : 0;

    // Reseed только при явном бампе DEMO_DATA_VERSION. Прежняя эвристика
    // hasLegacyParkings считала любую добавленную оператором парковку (напр. в
    // Калининграде) "legacy" → на каждом рестарте выносила к операторские парковки,
    // и все поездки/кошельки/платежи. Убираем — seed контролируется только версией.
    const needsReseed = storedVersion < DEMO_DATA_VERSION;
    if (!needsReseed) return;

    await client.query("BEGIN");
    // Стираем ТОЛЬКО demo-строки. Ключевое изменение: все DELETE теперь
    // фильтруют по seed=TRUE или по demo-user-id. Операторские парковки, реальные
    // кошельки, платежи и поездки обычных юзеров — не трогаем.
    const DEMO_USERS = ['demo', 'user-2', 'user-3', 'user-4', 'user-5'];
    await client.query(`
      DELETE FROM ticket_comments WHERE ticket_id IN (
        SELECT id FROM tickets WHERE bike_id IN (SELECT id FROM bikes WHERE seed = TRUE)
      );
      DELETE FROM rides   WHERE bike_id IN (SELECT id FROM bikes WHERE seed = TRUE)
                               AND user_id = ANY($1::text[]);
      DELETE FROM tickets WHERE bike_id IN (SELECT id FROM bikes WHERE seed = TRUE);
      DELETE FROM payments WHERE user_id = ANY($1::text[]);
      DELETE FROM wallet   WHERE user_id = ANY($1::text[]);
      DELETE FROM zones;
      DELETE FROM parkings WHERE seed = TRUE;
      DELETE FROM bikes    WHERE seed = TRUE;
    `, [DEMO_USERS]);
    await populateDemoData(client);
    await client.query(
      "INSERT INTO meta (key, value) VALUES ('demo_data_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [String(DEMO_DATA_VERSION)],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure — original error is rethrown below
    }
    throw err;
  } finally {
    client.release();
  }
}

// The full bootstrap sequence, awaited once by the server before it serves
// requests. Import order previously guaranteed a ready schema; now the server
// must `await bootstrapReady`.
export const bootstrapReady: Promise<void> = (async () => {
  await createSchema();
  await runMigrations();
  await createIndexes();
  await bootstrapDemoData();
})();

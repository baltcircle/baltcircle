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
import { logger } from "../logger";
import { runSchemaMigrations } from "./migrate";
import type pg from "pg";
export { pool, db } from "./client";
import { pool } from "./client";

// ---------- Schema bootstrap ----------
// Historical ad-hoc `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN
// IF NOT EXISTS` bootstrap has been retired in favour of versioned Drizzle
// migrations (see server/db/migrate.ts + migrations/). The full schema is
// created/altered exclusively by runSchemaMigrations() now.

// ---------- Runtime data-integrity guards ----------
// Every structural index (including the hot-path ones on rides/users/bikes/
// payment tables) is now a first-class Drizzle definition in shared/schema.ts
// and is created/altered exclusively by versioned migrations (server/db/
// migrate.ts) — this function no longer derives any DDL from schema.ts.
//
// What remains here are two partial UNIQUE indexes that are NOT safe to bake
// into a plain migration, because creating them can fail on real production
// data (pre-existing races/duplicates) and that failure needs a compensating
// action, not a crashed boot or a stuck migration:
//   - ride-double-booking guard: cleans up stale "active" rides first;
//   - phone/email uniqueness guard: logs actionable duplicates and lets the
//     app keep running without the DB-level guarantee until they're cleaned.
// Both are idempotent (`IF NOT EXISTS`) and cheap to re-check on every boot.
async function applyRuntimeDataGuards() {
  await createRideRaceGuardIndexes();
  await createContactUniquenessGuardIndexes();
}

// Database-level backstop for the startRide double-booking race (audit
// CRITICAL #4): storage.ts now serialises the check-and-claim with
// SELECT ... FOR UPDATE, but that guard lives entirely in application code —
// if it is ever weakened by a future change, these partial UNIQUE indexes
// make a second simultaneously active ride for the same bike, or the same
// rider, impossible for Postgres to accept at all.
//
// Creating a UNIQUE index fails outright if the table already violates it, so
// pre-existing duplicate active rides (exactly what the race being fixed here
// could have produced) are resolved first — keep the most recently started
// ride active and cancel the rest, then free any bike left stuck "rented"
// with no active ride pointing at it. Every statement here is idempotent: on
// a healthy database each one matches zero rows on every subsequent boot.
async function createRideRaceGuardIndexes() {
  await pool.query(`
    UPDATE rides SET status = 'cancelled'
    WHERE status = 'active' AND id NOT IN (
      SELECT DISTINCT ON (bike_id) id FROM rides
      WHERE status = 'active' ORDER BY bike_id, started_at DESC, id DESC
    )
  `);
  await pool.query(`
    UPDATE rides SET status = 'cancelled'
    WHERE status = 'active' AND id NOT IN (
      SELECT DISTINCT ON (user_id) id FROM rides
      WHERE status = 'active' ORDER BY user_id, started_at DESC, id DESC
    )
  `);
  await pool.query(`
    UPDATE bikes SET status = 'available'
    WHERE status = 'rented' AND id NOT IN (SELECT bike_id FROM rides WHERE status = 'active')
  `);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rides_active_bike ON rides (bike_id) WHERE status = 'active';`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rides_active_user ON rides (user_id) WHERE status = 'active';`,
  );
}

// Audit HIGH #16: phone/email have no DB-level uniqueness guarantee today —
// verifyOtp/verifyPhoneChange/verifyEmailChange all do a plain "SELECT ...
// then INSERT/UPDATE" check in application code, so two requests racing on
// the same contact can both pass the check and create/claim duplicate
// accounts. A partial UNIQUE index is the DB-level backstop, same pattern as
// createRideRaceGuardIndexes above.
//
// Only *active* rows are covered: deleteAccount rewrites phone to a
// per-id-unique 'deleted:<id>' placeholder and clears email, so excluding
// deleted_at IS NOT NULL rows is purely an optimisation, not a correctness
// requirement — but it keeps the index small and matches the app's own
// notion of "in-use" contact info. Email is only enforced unique once
// VERIFIED, matching storage.ts's existing rule that only a verified email on
// another account blocks a claim (an unverified, never-confirmed email is not
// a proven identity yet).
//
// Unlike the ride-race guard, pre-existing duplicate *real user accounts*
// cannot be auto-resolved here — merging two accounts' rides/wallet/history
// is a product/support decision, not something bootstrap should do silently.
// So each CREATE UNIQUE INDEX is wrapped: if the table already has
// conflicting rows, Postgres rejects the whole statement (23505) and we log
// a loud, actionable warning instead of crashing app startup. The index will
// simply get created automatically on a later boot once the data is cleaned
// up — until then, the app keeps running with just the application-level
// check (unchanged from today).
async function createContactUniquenessGuardIndexes() {
  await tryCreateUniqueIndex(
    "idx_users_phone_active",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_active ON users (phone) WHERE deleted_at IS NULL;`,
    `SELECT phone, array_agg(id) AS ids FROM users
     WHERE deleted_at IS NULL GROUP BY phone HAVING COUNT(*) > 1 LIMIT 20`,
  );
  await tryCreateUniqueIndex(
    "idx_users_email_verified_active",
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_verified_active ON users (email)
     WHERE deleted_at IS NULL AND email_verified_at IS NOT NULL;`,
    `SELECT email, array_agg(id) AS ids FROM users
     WHERE deleted_at IS NULL AND email_verified_at IS NOT NULL
     GROUP BY email HAVING COUNT(*) > 1 LIMIT 20`,
  );
}

async function tryCreateUniqueIndex(indexName: string, createSql: string, duplicatesSql: string) {
  try {
    await pool.query(createSql);
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "23505") throw err;
    const dupes = await pool.query(duplicatesSql);
    logger.error({
      indexName,
      duplicateGroups: dupes.rows,
      errorCode: "CONTACT_UNIQUENESS_INDEX_BLOCKED",
    }, `[bootstrap] не удалось создать ${indexName} — в БД уже есть дублирующиеся контакты; требуется ручная очистка, приложение продолжает работу без DB-уровневой гарантии`);
  }
}


// Audit HIGH #9: one-time backfill that encrypts any RebillId/AccountToken
// rows written before payment-token encryption existed, and fills in their
// blind-index (hash) columns so the card/account dedup lookup in
// updatePaymentMethod keeps working for them. Idempotent and cheap to re-run
// on every boot — it only touches rows whose value doesn't yet carry the
// "v1:" ciphertext prefix, so already-encrypted rows are skipped untouched.
async function encryptLegacyPaymentTokens() {
  const { encryptToken, hashTokenForLookup } = await import("../crypto/payment-tokens");
  const rows = await pool.query<{ id: number; rebill_id: string | null; account_token: string | null }>(
    `SELECT id, rebill_id, account_token FROM payment_methods
       WHERE (rebill_id IS NOT NULL AND rebill_id != '' AND rebill_id NOT LIKE 'v1:%')
          OR (account_token IS NOT NULL AND account_token != '' AND account_token NOT LIKE 'v1:%')`,
  );
  if (rows.rowCount === 0) return;
  let migrated = 0;
  for (const row of rows.rows) {
    const rebillPlain = row.rebill_id && !row.rebill_id.startsWith("v1:") ? row.rebill_id : null;
    const accountPlain = row.account_token && !row.account_token.startsWith("v1:") ? row.account_token : null;
    if (!rebillPlain && !accountPlain) continue;
    await pool.query(
      `UPDATE payment_methods SET
         rebill_id = COALESCE($1, rebill_id),
         rebill_id_hash = COALESCE($2, rebill_id_hash),
         account_token = COALESCE($3, account_token),
         account_token_hash = COALESCE($4, account_token_hash)
       WHERE id = $5`,
      [
        rebillPlain ? encryptToken(rebillPlain) : null,
        rebillPlain ? hashTokenForLookup(rebillPlain) : null,
        accountPlain ? encryptToken(accountPlain) : null,
        accountPlain ? hashTokenForLookup(accountPlain) : null,
        row.id,
      ],
    );
    migrated += 1;
  }
  if (migrated > 0) {
    logger.info({ migrated }, "encryptLegacyPaymentTokens: encrypted plaintext RebillId/AccountToken rows at rest");
  }
}

// Production received malformed pending card-binding rows before the binding
// flow reliably persisted its provider identifier. They cannot correspond to a
// live AddCard/Init session, so resolve them once at startup instead of leaving
// invisible rows able to permanently fail-close a rider's next bind attempt.
// This is deliberately narrower than a TTL migration: a row with either usable
// RequestKey or PaymentId remains untouched and is reconciled with T-Bank.
async function cleanupStaleIdentifierlessPendingCardBindings() {
  const now = Date.now();
  const staleBefore = now - 60 * 60 * 1000;
  const result = await pool.query(
    `UPDATE payment_methods
       SET status = 'failed',
           last_error_code = 'STALE_CLEANUP_NO_IDENTIFIER',
           last_error_message = 'Старая привязка не содержит идентификатор платёжного сервиса.',
           last_error_details = NULL,
           updated_at = $1
     WHERE status = 'pending'
       AND type = 'card'
       AND created_at < $2
       AND NULLIF(BTRIM(COALESCE(request_key, '')), '') IS NULL
       AND NULLIF(BTRIM(COALESCE(payment_id, '')), '') IS NULL`,
    [now, staleBefore],
  );
  if ((result.rowCount ?? 0) > 0) {
    logger.warn({
      count: result.rowCount,
      staleBefore,
      errorCode: "STALE_CLEANUP_NO_IDENTIFIER",
    }, "[bootstrap] failed stale identifier-less pending card bindings");
  }
}

const MODELS = ["BC Cruiser", "BC Comfort", "BC City+", "BC Lite"];

// Bump this whenever the demo geography/seed data changes so existing databases
// get refreshed automatically on next startup (MVP demo data — safe to wipe &
// reseed, it carries no real user data).
const DEMO_DATA_VERSION = 6;

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

  // Parkings FIRST — bikes.parking_id now carries a real FOREIGN KEY to
  // parkings.id (audit: слой данных MEDIUM/LOW, missing-FK finding), so the
  // referenced parking row must exist before any bike insert that points at
  // it, or the INSERT below fails with 23503 on a fresh (bikeCount === 0) DB.
  // Город берём из префикса названия («Город · Место») — для демо этого
  // достаточно.
  for (const p of PARKINGS) {
    const occupied = Math.min(p.capacity, Math.floor(rng() * p.capacity * 0.9));
    const city = p.name.split("·")[0].trim();
    await client.query(
      `INSERT INTO parkings (id, name, city, lat, lng, capacity, occupied, radius, status, notes, archived_at, seed, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,30,'active',NULL,NULL,TRUE,$8,NULL)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, city=EXCLUDED.city, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
         capacity=EXCLUDED.capacity, occupied=EXCLUDED.occupied, status='active',
         archived_at=NULL, seed=TRUE`,
      [p.id, p.name, city, p.y, p.x, p.capacity, occupied, now],
    );
  }

  // Bikes — a small sample fleet placed near parkings, all "available". Must
  // run AFTER the parkings loop above (see comment there).
  for (let i = 1; i <= DEMO_BIKE_COUNT; i++) {
    const id = `BC-${String(i).padStart(3, "0")}`;
    const model = MODELS[i % MODELS.length];
    const p = PARKINGS[i % PARKINGS.length];
    const x = p.x + (rng() - 0.5) * 18;
    const y = p.y + (rng() - 0.5) * 18;
    const battery = Math.max(45, Math.min(100, Math.round(60 + rng() * 40)));
    const idleHours = +(rng() * 6).toFixed(1);
    const lastSeen = now - Math.round(idleHours * 3600 * 1000);
    // ON CONFLICT: на боевой БД демо-велосипеды могли остаться с seed=FALSE
    // (легаси) → DELETE ... WHERE seed=TRUE их не чистит, INSERT падает на PK.
    // Обновляем и проставляем seed=TRUE, чтобы будущие reseed работали.
    await client.query(
      `INSERT INTO bikes (id, model, status, battery, lat, lng, last_seen, idle_hours, flagged, parking_id, seed)
       VALUES ($1,$2,'available',$3,$4,$5,$6,$7,FALSE,$8,TRUE)
       ON CONFLICT (id) DO UPDATE SET
         model=EXCLUDED.model, status=EXCLUDED.status, battery=EXCLUDED.battery,
         lat=EXCLUDED.lat, lng=EXCLUDED.lng, last_seen=EXCLUDED.last_seen,
         idle_hours=EXCLUDED.idle_hours, flagged=EXCLUDED.flagged,
         parking_id=EXCLUDED.parking_id, seed=TRUE`,
      [id, model, battery, y, x, lastSeen, idleHours, p.id],
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

  // Демо-активность пользователей (кошелёк, платежи, поездки, заявки) не
  // создаётся — только инфраструктура: велосипеды, парковки, зоны.
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
    // Каждый DELETE — отдельным запросом. Запрос с параметром ($1) и несколькими
    // командами pg шлёт как prepared statement → «cannot insert multiple commands».
    await client.query(`
      DELETE FROM ticket_comments WHERE ticket_id IN (
        SELECT id FROM tickets WHERE bike_id IN (SELECT id FROM bikes WHERE seed = TRUE)
      )`);
    // Всё активность демо-юзеров — демо (это фейковые аккаунты), чистим полностью.
    await client.query(`DELETE FROM rides WHERE user_id = ANY($1::text[])`, [DEMO_USERS]);
    await client.query(`DELETE FROM tickets WHERE bike_id IN (SELECT id FROM bikes WHERE seed = TRUE)`);
    await client.query(`DELETE FROM payments WHERE user_id = ANY($1::text[])`, [DEMO_USERS]);
    await client.query(`DELETE FROM wallet   WHERE user_id = ANY($1::text[])`, [DEMO_USERS]);
    await client.query(`DELETE FROM zones`);
    // Bikes BEFORE parkings — bikes.parking_id now has a real FOREIGN KEY to
    // parkings.id (see populateDemoData comment above); deleting the parking
    // row first would fail with 23503 while a seed bike still points at it.
    await client.query(`DELETE FROM bikes    WHERE seed = TRUE`);
    await client.query(`DELETE FROM parkings WHERE seed = TRUE`);
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
  await runSchemaMigrations();
  await cleanupStaleIdentifierlessPendingCardBindings();
  await encryptLegacyPaymentTokens();
  await applyRuntimeDataGuards();
  await bootstrapDemoData();
})();

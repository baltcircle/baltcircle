// Versioned schema migrations (audit HIGH #17). Replaces the old ad-hoc
// `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
// bootstrap with drizzle-kit-generated migrations under migrations/, applied
// here via drizzle-orm's own migrate() runner.
//
// Imports pool/db from ./client (not ./bootstrap) to avoid a circular import:
// bootstrap.ts imports runSchemaMigrations from this file.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pool, db } from "./client";
import { logger } from "../logger";

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "migrations");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

// A database that predates this migration system has its full schema already
// applied via the old bootstrap code, but no drizzle.__drizzle_migrations
// tracking table (or an empty one). Left alone, drizzle's migrate() would try
// to re-run the baseline migration's CREATE TABLE/CREATE INDEX statements
// against tables that already exist and fail outright.
//
// drizzle's own skip decision (pg-core/dialect.js: PgDialect.migrate) is
// purely timestamp-based — it compares the tracking table's most recent
// created_at to each migration's folderMillis, and skips any migration whose
// folderMillis it has already passed. It never compares hashes. So marking
// the baseline as "already applied" only requires inserting one row with
// created_at == the baseline's folderMillis; the hash value itself is never
// checked for the skip decision, but we still compute the real sha256 (the
// same way drizzle's migrator does) so the tracking table stays consistent
// with what a genuinely-fresh database would have recorded.
//
// On a genuinely fresh/empty database `usersTableExists` is false, so this is
// a complete no-op and migrate() applies the baseline (and everything after
// it) normally.
async function adoptExistingDatabase(): Promise<void> {
  const { rows: userTableRows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'
     ) AS exists;`,
  );
  const usersTableExists = userTableRows[0]?.exists === true;
  if (!usersTableExists) return;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);

  const { rows: countRows } = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::int AS c FROM drizzle.__drizzle_migrations;`,
  );
  const alreadyTracked = Number(countRows[0]?.c ?? 0) > 0;
  if (alreadyTracked) return;

  const journalPath = path.join(MIGRATIONS_FOLDER, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    // No migrations have been generated yet — nothing to adopt against.
    return;
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: JournalEntry[];
  };
  const baseline = journal.entries.find((e) => e.idx === 0);
  if (!baseline) return;

  const sqlPath = path.join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`);
  const sqlContent = readFileSync(sqlPath, "utf-8");
  const hash = createHash("sha256").update(sqlContent).digest("hex");

  await pool.query(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2);`,
    [hash, baseline.when],
  );
  logger.info(
    { baselineTag: baseline.tag },
    "adopted pre-existing database into drizzle migration tracking (baseline marked as already applied)",
  );
}

// server/omni/index.ts (a separate deployable process/container, see
// script/build.ts) calls bootstrapReady — and therefore this function —
// independently from the main web app. If both start at once against a
// fresh database they would race on the baseline's plain `CREATE TABLE`
// statements (drizzle-kit does not emit IF NOT EXISTS) and one would crash.
// A session-level Postgres advisory lock serialises the whole adopt+migrate
// sequence across processes/containers without needing any app-level
// coordination — held on a dedicated connection for the duration, so it
// can't be released early by pool reuse.
const MIGRATION_LOCK_KEY = 875_331_042;

export async function runSchemaMigrations(): Promise<void> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await adoptExistingDatabase();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

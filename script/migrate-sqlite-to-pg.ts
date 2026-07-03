// One-shot data migration: legacy SQLite data.db  ->  Postgres (DATABASE_URL).
//
// Copies every row of every known table from the old better-sqlite3 file into
// the already-bootstrapped Postgres schema, preserving primary keys, then
// resets each SERIAL sequence to MAX(id) so future inserts don't collide.
//
// The Postgres schema MUST already exist. Boot it once WITHOUT demo seeding so
// the imported production rows don't collide with demo serial ids, e.g.:
//   SKIP_DEMO_SEED=1 DATABASE_URL=... npx tsx -e \
//     "import('./server/db/bootstrap').then(m=>m.bootstrapReady).then(()=>process.exit(0))"
// This script only moves data; it never creates tables.
//
// Idempotent: rows are inserted with ON CONFLICT DO NOTHING, so re-running skips
// rows that were already copied.
//
// Usage:
//   DATABASE_URL=postgres://user:pass@host:5432/db \
//   SQLITE_PATH=/path/to/data.db \
//   npx tsx script/migrate-sqlite-to-pg.ts [--dry-run]
//
import Database from "better-sqlite3";
import { Pool } from "pg";

const SQLITE_PATH = process.env.SQLITE_PATH ?? "data.db";
const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.argv.includes("--dry-run");

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

// Tables in FK-safe insertion order (parents before children).
const TABLES = [
  "bikes",
  "parkings",
  "zones",
  "users",
  "wallet",
  "meta",
  "otp_requests",
  "phone_change_requests",
  "map_objects",
  "support_tickets",
  "rides",
  "ride_points",
  "tickets",
  "ticket_comments",
  "payments",
  "payment_methods",
  "payment_orders",
] as const;

// SQLite stores booleans as 0/1 integers; Postgres wants real booleans.
const BOOLEAN_COLUMNS: Record<string, string[]> = {
  bikes: ["flagged", "seed"],
  parkings: ["seed"],
  map_objects: ["active"],
  otp_requests: ["consumed"],
  phone_change_requests: ["consumed"],
};

// Tables whose primary key is a SERIAL `id`; sequence must be reset after load.
const SERIAL_TABLES = [
  "rides",
  "tickets",
  "ticket_comments",
  "payments",
  "map_objects",
  "payment_methods",
  "support_tickets",
  "payment_orders",
  "ride_points",
];

function coerceRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const bools = BOOLEAN_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = { ...row };
  for (const col of bools) {
    if (col in out && out[col] != null) {
      out[col] = out[col] === 1 || out[col] === true || out[col] === "1";
    }
  }
  return out;
}

async function main() {
  // Open read-write so SQLite can flush the WAL into the main db file before we
  // read. A stale data.db-wal (uncheckpointed transactions) would otherwise hide
  // the freshest rows. We only ever SELECT, but the checkpoint needs write access.
  const sqlite = new Database(SQLITE_PATH);
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    console.warn("WAL checkpoint skipped:", (e as Error).message);
  }
  const pg = new Pool({ connectionString: DATABASE_URL });

  // Only migrate tables that actually exist in the source DB.
  const existing = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );

  const summary: Record<string, { read: number; inserted: number }> = {};

  const client = await pg.connect();
  try {
    if (!DRY_RUN) await client.query("BEGIN");

    for (const table of TABLES) {
      if (!existing.has(table)) {
        console.log(`- ${table}: not present in source, skipped`);
        continue;
      }

      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      summary[table] = { read: rows.length, inserted: 0 };
      if (rows.length === 0) {
        console.log(`- ${table}: 0 rows`);
        continue;
      }

      // Intersect source columns with the target Postgres columns. The legacy
      // SQLite file may physically retain columns that were dropped from the
      // current schema (e.g. payment_orders.kind); inserting them would fail
      // with "column ... does not exist". We only copy columns the target has.
      const pgCols = new Set(
        (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
            [table],
          )
        ).rows.map((r: { column_name: string }) => r.column_name),
      );
      const sourceCols = Object.keys(rows[0]);
      const columns = sourceCols.filter((c) => pgCols.has(c));
      const droppedCols = sourceCols.filter((c) => !pgCols.has(c));
      if (droppedCols.length > 0) {
        console.log(`  (skipping legacy columns not in target: ${droppedCols.join(", ")})`);
      }
      const colList = columns.map((c) => `"${c}"`).join(", ");
      const conflictTarget = table === "payment_orders" ? "(order_id)" : "";
      // Prefer the primary key conflict target when we can infer it; otherwise
      // fall back to ON CONFLICT DO NOTHING with no target (works for any PK).

      for (const raw of rows) {
        const row = coerceRow(table, raw);
        const values = columns.map((c) => row[c]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
        if (DRY_RUN) {
          summary[table].inserted++;
          continue;
        }
        const res = await client.query(sql, values);
        summary[table].inserted += res.rowCount ?? 0;
      }
      void conflictTarget;
      console.log(`- ${table}: read ${summary[table].read}, inserted ${summary[table].inserted}`);
    }

    // Reset SERIAL sequences so new inserts continue past the copied max id.
    if (!DRY_RUN) {
      for (const table of SERIAL_TABLES) {
        if (!existing.has(table)) continue;
        await client.query(
          `SELECT setval(
             pg_get_serial_sequence($1, 'id'),
             COALESCE((SELECT MAX(id) FROM ${table}), 1),
             (SELECT COUNT(*) FROM ${table}) > 0
           )`,
          [table],
        );
      }
      await client.query("COMMIT");
    }
  } catch (err) {
    if (!DRY_RUN) await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  sqlite.close();
  await pg.end();

  console.log(`\n${DRY_RUN ? "[DRY RUN] " : ""}Migration complete.`);
  const totalRead = Object.values(summary).reduce((a, b) => a + b.read, 0);
  const totalIns = Object.values(summary).reduce((a, b) => a + b.inserted, 0);
  console.log(`Total: read ${totalRead} rows, inserted ${totalIns} rows across ${Object.keys(summary).length} tables.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

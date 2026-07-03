// Shared helpers for the smoke test suite after the SQLite -> PostgreSQL
// migration. Each smoke test gets its OWN throwaway Postgres database
// (baltcircle_smoke_<name>) so tests are fully isolated and can run in any
// order without clobbering each other's rows.
//
// The tests originally used better-sqlite3 directly for post-run assertions
// (new Database(path).prepare(sql).get/all/run, .exec, PRAGMA table_info).
// To keep the test bodies almost unchanged, this module exposes a tiny async
// adapter (openTestDb) that mimics that surface on top of `pg`, plus explicit
// helpers for the parts that cannot be emulated 1:1 (multi-statement exec,
// table introspection).
//
// SQLite used `?` positional placeholders; Postgres uses `$1, $2, ...`. The
// adapter rewrites `?` -> `$n` automatically so existing test SQL keeps working.
import { Pool, types as pgTypes, type PoolClient } from "pg";
import type { ChildProcess } from "node:child_process";

// BIGINT (oid 20) is used for unix-ms timestamps (schema uses bigint mode:number).
// node-postgres returns BIGINT as a string by default; parse to Number so test
// assertions like `typeof row.consent_accepted_at === "number"` hold, matching
// the server's own parser in server/db/bootstrap.ts.
pgTypes.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// The maintenance/admin URL used to CREATE/DROP the per-test databases. Points
// at the `postgres` maintenance DB on the same server as DATABASE_URL. Falls
// back to the local test cluster on port 5433 (see the smoke test runbook).
const ADMIN_URL =
  process.env.SMOKE_ADMIN_URL ||
  process.env.DATABASE_URL?.replace(/\/[^/]+(\?|$)/, "/postgres$1") ||
  "postgresql://postgres@127.0.0.1:5433/postgres";

// Base URL whose database name we swap per test. Defaults to the local cluster.
const BASE_URL = process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5433/baltcircle";

function dbNameFor(name: string): string {
  // Postgres identifiers: lowercase, alnum + underscore, <=63 chars.
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `baltcircle_smoke_${safe}`.slice(0, 63);
}

function urlWithDb(base: string, dbName: string): string {
  return base.replace(/\/[^/]+(\?|$)/, `/${dbName}$1`);
}

// Create a fresh, empty database for a test and return its DATABASE_URL. Drops
// any leftover from a previous crashed run first so the test starts clean.
export async function createTestDb(name: string): Promise<{ url: string; dbName: string }> {
  const dbName = dbNameFor(name);
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    // Terminate stragglers, then drop + recreate.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  return { url: urlWithDb(BASE_URL, dbName), dbName };
}

// Drop a per-test database after the test finishes. Best-effort: never throws.
export async function dropTestDb(name: string): Promise<void> {
  const dbName = dbNameFor(name);
  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch {
    // ignore cleanup failures
  } finally {
    await admin.end();
  }
}

// Gracefully stop the spawned server, wait for it to fully exit (so it closes
// its own pg pool), then drop the throwaway database. Dropping while the server
// still holds connections forces pg_terminate_backend, which makes the server's
// pool emit an unhandled 'error' — waiting for exit first avoids that noise.
export async function teardown(name: string, server: ChildProcess | undefined): Promise<void> {
  if (server && server.exitCode === null && !server.killed) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      server.once("exit", done);
      server.kill("SIGTERM");
      // Fallback: don't hang teardown if the process ignores SIGTERM.
      setTimeout(() => {
        try {
          server.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 3000).unref?.();
    });
  }
  await dropTestDb(name);
}

// Rewrite SQLite `?` placeholders to Postgres `$1, $2, ...`. Only touches `?`
// characters that are placeholders (the test SQL contains no `?` in string
// literals), so a simple sequential replace is safe here.
function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// A thin async adapter over a pooled pg client that mimics the subset of the
// better-sqlite3 API the smoke tests use: db.prepare(sql).get/all/run(...args),
// db.exec(sql), and db.close(). All methods are async (return Promises) — the
// tests already `await` their DB reads after this migration.
export interface TestDb {
  prepare(sql: string): {
    get<T = any>(...args: unknown[]): Promise<T | undefined>;
    all<T = any>(...args: unknown[]): Promise<T[]>;
    run(...args: unknown[]): Promise<void>;
  };
  exec(sql: string): Promise<void>;
  // List column names of a table (Postgres replacement for PRAGMA table_info).
  columns(table: string): Promise<string[]>;
  close(): Promise<void>;
}

export async function openTestDb(url: string): Promise<TestDb> {
  const pool = new Pool({ connectionString: url });
  const client: PoolClient = await pool.connect();
  return {
    prepare(sql: string) {
      const text = toPgPlaceholders(sql);
      return {
        async get<T = any>(...args: unknown[]): Promise<T | undefined> {
          const r = await client.query(text, args as unknown[]);
          return r.rows[0] as T | undefined;
        },
        async all<T = any>(...args: unknown[]): Promise<T[]> {
          const r = await client.query(text, args as unknown[]);
          return r.rows as T[];
        },
        async run(...args: unknown[]): Promise<void> {
          await client.query(text, args as unknown[]);
        },
      };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
    async columns(table: string): Promise<string[]> {
      const r = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      );
      return r.rows.map((row) => row.column_name as string);
    },
    async close(): Promise<void> {
      client.release();
      await pool.end();
    },
  };
}

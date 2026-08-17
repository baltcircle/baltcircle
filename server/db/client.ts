// ---------- Database connection (pg Pool + Drizzle client) ----------
// Split out of bootstrap.ts so the migration runner (migrate.ts) can import
// the connection without a circular dependency on the bootstrap module.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

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
export const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db = drizzle(pool);

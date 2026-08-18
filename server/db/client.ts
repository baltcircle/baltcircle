// ---------- Database connection (pg Pool + Drizzle client) ----------
// Split out of bootstrap.ts so the migration runner (migrate.ts) can import
// the connection without a circular dependency on the bootstrap module.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { logger } from "../logger";

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

// Audit MEDIUM: an idle pooled client that loses its connection (network
// blip, DB restart, managed-Postgres failover) emits an 'error' event on the
// pool. node-postgres's pool is an EventEmitter — with zero listeners an
// 'error' event is rethrown as an uncaught exception on the next tick and
// crashes the whole Node process, taking down every in-flight request, not
// just the one that hit the bad connection. Logging and swallowing it here
// is safe: the pool itself already discards the dead client and hands the
// next `.connect()`/query a fresh one, so no compensating retry logic is
// needed at this layer.
pool.on("error", (err) => {
  logger.error({ err }, "[db] idle pool client emitted an error — connection dropped, pool will reconnect on next query");
});

export const db = drizzle(pool);

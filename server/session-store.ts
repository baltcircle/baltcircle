import session, { type SessionData } from "express-session";
import connectPgSimple from "connect-pg-simple";
import type { Pool } from "pg";

const PgStore = connectPgSimple(session);
const TOUCH_INTERVAL_SECONDS = 60;
type Options = Pick<connectPgSimple.PGStoreOptions,
  "schemaName" | "tableName" | "createTableIfMissing" | "pruneSessionInterval" | "ttl"
> & { pool: Pool };
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/**
 * Keep the standard durable get/set/destroy behaviour, but avoid a WAL write
 * on every read-only API response. The SQL predicate works across processes:
 * concurrent UPDATEs recheck it after waiting for a row lock.
 *
 * No authentication data is cached and no background writes are queued.
 * The 30-day TTL is unchanged; read-side renewal has at most 60s granularity.
 * Explicit saves (login/CSRF/shorter cookie lifetime) remain immediate.
 */
export class SessionStore extends PgStore {
  private readonly sessionPool: Pool;
  private readonly sessionTable: string;
  private readonly fallbackTtl: number;

  constructor(options: Options) {
    super(options);
    this.sessionPool = options.pool;
    this.sessionTable = `${quoteIdentifier(options.schemaName ?? "public")}.${quoteIdentifier(options.tableName ?? "session")}`;
    this.fallbackTtl = options.ttl || 86400;
  }

  override touch(sid: string, value: SessionData, callback?: (error?: Error) => void): void {
    const now = Math.ceil(Date.now() / 1000);
    const expires = value.cookie.expires
      ? Math.ceil(new Date(value.cookie.expires).getTime() / 1000)
      : now + this.fallbackTtl;
    if (!Number.isFinite(expires)) {
      callback?.(new Error("Invalid session expiration"));
      return;
    }
    // Short-lived sessions need a proportionally smaller renewal window.
    const interval = Math.min(TOUCH_INTERVAL_SECONDS, Math.floor(Math.max(0, expires - now) / 4));
    void this.sessionPool.query(
      `UPDATE ${this.sessionTable} SET expire = to_timestamp($1)
       WHERE sid = $2 AND expire >= to_timestamp($3)
         AND expire < to_timestamp($1)
         AND expire <= to_timestamp($1 - $4::double precision)`,
      [expires, sid, now, interval],
    ).then(
      () => callback?.(),
      (error: Error) => callback?.(error),
    );
  }
}

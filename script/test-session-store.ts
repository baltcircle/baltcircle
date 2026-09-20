// Opt-in, isolated schema only. Never use a production database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SessionData } from "express-session";
import { SessionStore } from "../server/session-store";

const url = process.env.DATABASE_URL;
assert(url && /_test(?:\?|$)/.test(url), "An explicit *_test database is required");
const pool = new pg.Pool({ connectionString: url, max: 10 });
const schema = `session_test_${randomUUID().replaceAll("-", "")}`;
const table = `"${schema}"."session"`;
const store = new SessionStore({
  pool, schemaName: schema, createTableIfMissing: true, pruneSessionInterval: false,
});
const ttl = 30 * 24 * 60 * 60 * 1000;
const expires = Math.ceil((Date.now() + ttl) / 1000) * 1000;
const data = (end: number): SessionData => ({
  cookie: { expires: new Date(end), originalMaxAge: ttl, httpOnly: true },
  userId: "synthetic-session-user", csrfToken: "synthetic-csrf",
} as SessionData);
const set = (sid: string, value: SessionData) => new Promise<void>((resolve, reject) =>
  store.set(sid, value, err => err ? reject(err) : resolve()));
const touch = (sid: string, end: number) => new Promise<void>((resolve, reject) =>
  store.touch(sid, data(end), ((err?: Error) => err ? reject(err) : resolve()) as () => void));
const get = (sid: string) => new Promise<SessionData | null | undefined>((resolve, reject) =>
  store.get(sid, (err, value) => err ? reject(err) : resolve(value)));
const destroy = (sid: string) => new Promise<void>((resolve, reject) =>
  store.destroy(sid, err => err ? reject(err) : resolve()));
const writes = async () => Number((await pool.query(`SELECT count(*) n FROM "${schema}".writes`)).rows[0].n);
const expiry = async () => (await pool.query(`SELECT extract(epoch FROM expire)*1000 AS t FROM ${table} WHERE sid='rider'`)).rows[0]?.t;

try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await set("rider", data(expires));
  await pool.query(`CREATE TABLE "${schema}".writes (id serial);
    CREATE FUNCTION "${schema}".count_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO "${schema}".writes DEFAULT VALUES; RETURN NEW; END $$;
    CREATE TRIGGER count_write AFTER UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION "${schema}".count_write()`);
  assert.equal((await get("rider"))?.csrfToken, "synthetic-csrf");
  await Promise.all(Array.from({ length: 100 }, () => touch("rider", expires + 1000)));
  assert.equal(await writes(), 0, "ordinary parallel reads must not rewrite fresh sessions");
  assert.equal(Number(await expiry()), expires);

  // All processes share the SQL guard: a burst at the refresh boundary writes once.
  const otherStore = new SessionStore({
    pool, schemaName: schema, createTableIfMissing: false, pruneSessionInterval: false,
  });
  await Promise.all(Array.from({ length: 100 }, (_, i) => i % 2
    ? touch("rider", expires + 60000)
    : new Promise<void>((resolve, reject) => otherStore.touch("rider", data(expires + 60000),
      ((err?: Error) => err ? reject(err) : resolve()) as () => void))));
  otherStore.close();
  assert.equal(await writes(), 1, "concurrent expiry refresh must produce one physical update");
  assert.equal(Number(await expiry()), expires + 60000);
  await touch("rider", expires); // A slow request must not move expiry backwards.
  assert.equal(Number(await expiry()), expires + 60000);
  assert.equal(await writes(), 1);

  const changed = { ...data(expires + 61000), csrfToken: "rotated-csrf" } as SessionData;
  await set("rider", changed);
  assert.equal((await get("rider"))?.csrfToken, "rotated-csrf", "real changes persist immediately");
  assert.equal(Number(await expiry()), expires + 61000);
  // Explicit save may shorten the session; only read-side touch is monotonic.
  await set("rider", data(Date.now() + 20000));
  assert(Number(await expiry()) < Date.now() + 21000);
  await touch("rider", expires);
  assert.equal(Number(await expiry()), expires, "near-expiry sessions refresh immediately");

  await set("expired", data(Date.now() - 10000));
  await touch("expired", expires);
  assert.equal(await get("expired"), undefined, "touch must never revive an expired session");
  await destroy("rider");
  await touch("rider", expires);
  assert.equal(await get("rider"), undefined, "touch must never resurrect a logged-out session");
  await set("rotated-id", data(expires));
  assert.equal((await get("rotated-id"))?.userId, "synthetic-session-user");

  // Very short lifetimes do not use the 60s batching window.
  await set("short", data(Date.now() + 10000));
  const shortEnd = Math.ceil((Date.now() + 20000) / 1000) * 1000;
  await touch("short", shortEnd);
  assert.equal(Number((await pool.query(`SELECT extract(epoch FROM expire)*1000 AS t FROM ${table} WHERE sid='short'`)).rows[0].t), shortEnd);

  await pool.query(`DROP TABLE ${table}`);
  await assert.rejects(touch("missing-table", expires), "database failures must reach callbacks");
  console.log("PASS: batched writes, concurrency, expiry, CSRF saves, logout, rotation and DB errors");
} finally {
  store.close();
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}

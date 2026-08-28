// Audit F-08: out-of-order persistence. persistLockReport()/applyLiveUpdates()
// decode messages in arrival order, but each is its own async pool.query() —
// nothing guarantees their UPDATEs land in that same order once they are
// actually racing the pool. Before this fix, only `last_seen_at` was kept
// monotonic (via GREATEST); every other column (lock state, GPS fix, alarm,
// battery...) was overwritten unconditionally, so a stale report landing
// *after* a fresher one could silently roll the visible lock/bike state
// backwards while last_seen_at kept ticking forward.
//
// This fake models just enough real SQL semantics to prove the fix: it reads
// the same guard clause the production query now sends
// (`last_seen_at <= $2`) and skips the whole row update when it does not
// hold, exactly like Postgres would for a real UPDATE ... WHERE.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OmniMessage } from "@shared/omni/protocol";

interface FakeLockRow {
  last_seen_at: number | null;
  last_lock_state?: string;
  last_latitude?: number;
  last_longitude?: number;
}

interface FakeBikeRow {
  last_seen: number | null;
  lat?: number;
  lng?: number;
  battery?: number;
}

const fake = vi.hoisted(() => ({
  locks: new Map<string, FakeLockRow>(),
  bikes: new Map<string, FakeBikeRow>(),
  reset() {
    this.locks.clear();
    this.bikes.clear();
  },
}));

/** `col = $n` assignments in a SET clause — skips CASE/derived expressions
 *  like `status = CASE WHEN ... END`, which never match this shape. */
const ASSIGNMENT_RE = /(\w+)\s*=\s*\$(\d+)/g;

function applyGuardedUpdate(sql: string, params: unknown[], row: FakeLockRow): boolean {
  const guarded = sql.includes("last_seen_at <= $2");
  const at = params[1] as number;
  if (guarded && row.last_seen_at !== null && row.last_seen_at > at) return false;
  const setClause = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE"));
  for (const match of setClause.matchAll(ASSIGNMENT_RE)) {
    const [, column, paramIndex] = match;
    if (column === "status") continue; // CASE expression, not a real `$n` ref.
    (row as unknown as Record<string, unknown>)[column] = params[Number(paramIndex) - 1];
  }
  return true;
}

vi.mock("../db/bootstrap", () => ({
  pool: {
    async query(sql: string, params: unknown[] = []) {
      const text = sql.trim();
      if (text.startsWith("SELECT last_latitude, last_longitude FROM locks")) {
        const imei = params[0] as string;
        const row = fake.locks.get(imei);
        // Mirrors real node-postgres: NUMERIC columns come back as strings
        // (see server/db/client.ts — only BIGINT/OID 20 is parsed to Number),
        // so the store must coerce with Number() before doing arithmetic.
        return {
          rows: row === undefined ? [] : [{
            last_latitude: row.last_latitude != null ? String(row.last_latitude) : null,
            last_longitude: row.last_longitude != null ? String(row.last_longitude) : null,
          }],
        };
      }
      if (text.startsWith("UPDATE locks")) {
        const imei = params[0] as string;
        const row = fake.locks.get(imei) ?? { last_seen_at: null };
        applyGuardedUpdate(text, params, row);
        fake.locks.set(imei, row);
        return { rows: [] };
      }
      if (text.startsWith("UPDATE bikes")) {
        // applyLiveUpdates batches N rows via `FROM (VALUES ...) AS v(...)`.
        // Params are pushed 5 at a time: bikeId, x, y, batteryPct, t.
        for (let i = 0; i < params.length; i += 5) {
          const [bikeId, x, y, batteryPct, t] = params.slice(i, i + 5) as [string, number | null, number | null, number | null, number];
          const row = fake.bikes.get(bikeId) ?? { last_seen: null };
          if (row.last_seen !== null && row.last_seen > t) continue;
          if (x !== null) row.lng = x;
          if (y !== null) row.lat = y;
          if (batteryPct !== null) row.battery = batteryPct;
          row.last_seen = t;
          fake.bikes.set(bikeId, row);
        }
        return { rows: [] };
      }
      // rides side-effect query from the lockReport branch and anything else
      // not exercised by these tests.
      return { rows: [] };
    },
  },
  db: {},
  bootstrapReady: Promise.resolve(),
}));

import { PgOmniStore } from "./store";

const IMEI = "861234567890123";
const store = new PgOmniStore();

beforeEach(() => {
  fake.reset();
});

describe("persistLockReport ordering guard (audit F-08)", () => {
  it("rejects a stale heartbeat that arrives after a fresher one as a no-op", async () => {
    const fresh: OmniMessage = { type: "heartbeat", locked: false, voltageCv: 400, signal: 20 };
    const stale: OmniMessage = { type: "heartbeat", locked: true, voltageCv: 400, signal: 20 };

    // Fresher report (t=2000) is persisted first...
    await store.persistLockReport(IMEI, fresh, 2000);
    // ...then a stale, earlier-timestamped report (t=1000) lands late — this
    // is the exact race the audit describes: "сообщать locked, хотя более
    // поздний пакет говорил unlocked".
    await store.persistLockReport(IMEI, stale, 1000);

    expect(fake.locks.get(IMEI)).toMatchObject({ last_lock_state: "unlocked", last_seen_at: 2000 });
  });

  it("still applies an in-order (newer) heartbeat normally", async () => {
    const older: OmniMessage = { type: "heartbeat", locked: false, voltageCv: 400, signal: 20 };
    const newer: OmniMessage = { type: "heartbeat", locked: true, voltageCv: 400, signal: 20 };

    await store.persistLockReport(IMEI, older, 1000);
    await store.persistLockReport(IMEI, newer, 2000);

    expect(fake.locks.get(IMEI)).toMatchObject({ last_lock_state: "locked", last_seen_at: 2000 });
  });

  it("rejects a stale GPS fix that arrives after a fresher position report", async () => {
    const fresh: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 54.7104, lng: 20.4522, satellites: 8, hdop: 1, altitudeM: 10, fixedAt: 2000 },
    };
    const stale: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 10, lng: 10, satellites: 8, hdop: 1, altitudeM: 10, fixedAt: 1000 },
    };

    await store.persistLockReport(IMEI, fresh, 2000);
    await store.persistLockReport(IMEI, stale, 1000);

    expect(fake.locks.get(IMEI)).toMatchObject({ last_latitude: 54.7104, last_longitude: 20.4522, last_seen_at: 2000 });
  });

  it("rejects an implausible GPS jump even when it is genuinely the newest report (production incident, 2026-08-23)", async () => {
    const good: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 54.7104, lng: 20.4522, satellites: 8, hdop: 1, altitudeM: 10, fixedAt: 1000 },
    };
    // Structurally valid (passes nmeaToDecimal's +/-90/+/-180 bounds) but a
    // ~600km jump — the class of GNSS cold-fix/flyaway artifact that
    // corrupted BC-001's stored position in production. Arrives LATER than
    // `good`, so the NEWEST_REPORT_GUARD alone would happily accept it —
    // only the plausibility check should stop this one.
    const flyaway: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 60.5, lng: 30.5, satellites: 8, hdop: 1, altitudeM: 10, fixedAt: 2000 },
    };

    await store.persistLockReport(IMEI, good, 1000);
    await store.persistLockReport(IMEI, flyaway, 2000);

    // Position stays pinned at the last good fix; last_seen_at still advances
    // (the lock is online and reporting, it just didn't land a trustworthy fix).
    expect(fake.locks.get(IMEI)).toMatchObject({
      last_latitude: 54.7104, last_longitude: 20.4522, last_seen_at: 2000,
    });
  });

  it("accepts the very first fix ever recorded for a lock regardless of magnitude (nothing to compare against)", async () => {
    const firstEver: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 54.7104, lng: 20.4522, satellites: 8, hdop: 1, altitudeM: 10, fixedAt: 1000 },
    };

    await store.persistLockReport(IMEI, firstEver, 1000);

    expect(fake.locks.get(IMEI)).toMatchObject({
      last_latitude: 54.7104, last_longitude: 20.4522, last_seen_at: 1000,
    });
  });
});

describe("persistLockReport HDOP accuracy gate", () => {
  it("rejects a fix whose hdop exceeds MAX_ACCEPTABLE_HDOP, even as the very first fix ever", async () => {
    const poor: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 54.7104, lng: 20.4522, satellites: 5, hdop: 12, altitudeM: 10, fixedAt: 1000 },
    };

    const accepted = await store.persistLockReport(IMEI, poor, 1000);

    expect(accepted).toBe(false);
    // last_seen_at still advances (lock is online), but no position is stored.
    expect(fake.locks.get(IMEI)).toMatchObject({ last_seen_at: 1000 });
    expect(fake.locks.get(IMEI)?.last_latitude).toBeUndefined();
  });

  it("accepts a fix at exactly MAX_ACCEPTABLE_HDOP (boundary is inclusive)", async () => {
    const boundary: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 54.7104, lng: 20.4522, satellites: 6, hdop: 10, altitudeM: 10, fixedAt: 1000 },
    };

    const accepted = await store.persistLockReport(IMEI, boundary, 1000);

    expect(accepted).toBe(true);
    expect(fake.locks.get(IMEI)).toMatchObject({ last_latitude: 54.7104, last_longitude: 20.4522 });
  });

  it("does not overwrite a previously-good fix with a later poor-hdop one, even when it is the newest report", async () => {
    const good: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 54.7104, lng: 20.4522, satellites: 10, hdop: 2, altitudeM: 10, fixedAt: 1000 },
    };
    const poorButNewer: OmniMessage = {
      type: "position", cmd: "D0", tracking: true, valid: true,
      fix: { lat: 54.72, lng: 20.46, satellites: 4, hdop: 15, altitudeM: 10, fixedAt: 2000 },
    };

    await store.persistLockReport(IMEI, good, 1000);
    const accepted = await store.persistLockReport(IMEI, poorButNewer, 2000);

    expect(accepted).toBe(false);
    expect(fake.locks.get(IMEI)).toMatchObject({
      last_latitude: 54.7104, last_longitude: 20.4522, last_seen_at: 2000,
    });
  });
});

describe("applyLiveUpdates ordering guard (audit F-08)", () => {
  it("rejects a stale buffered live-position row that flushes after a fresher one", async () => {
    await store.applyLiveUpdates([{ bikeId: "bike-a", x: 20.5, y: 54.7, batteryPct: 90, t: 2000 }]);
    // A batch flush completing out of order (audit's concern for the writer's
    // per-flush-interval batching) must not roll the bike's position back.
    await store.applyLiveUpdates([{ bikeId: "bike-a", x: 10, y: 10, batteryPct: 5, t: 1000 }]);

    expect(fake.bikes.get("bike-a")).toMatchObject({ lng: 20.5, lat: 54.7, battery: 90, last_seen: 2000 });
  });

  it("still applies an in-order (newer) live-position row normally", async () => {
    await store.applyLiveUpdates([{ bikeId: "bike-a", x: 10, y: 10, batteryPct: 5, t: 1000 }]);
    await store.applyLiveUpdates([{ bikeId: "bike-a", x: 20.5, y: 54.7, batteryPct: 90, t: 2000 }]);

    expect(fake.bikes.get("bike-a")).toMatchObject({ lng: 20.5, lat: 54.7, battery: 90, last_seen: 2000 });
  });
});

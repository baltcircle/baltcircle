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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmniMessage } from "@shared/omni/protocol";

interface FakeLockRow {
  last_seen_at: number | null;
  last_lock_state?: string;
  last_latitude?: number;
  last_longitude?: number;
  bike_id?: string | null;
}

interface FakeBikeRow {
  last_seen: number | null;
  lat?: number;
  lng?: number;
  battery?: number;
  status?: string;
  maintenance_reason?: string | null;
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
        const applied = applyGuardedUpdate(text, params, row);
        fake.locks.set(imei, row);
        if (text.includes("RETURNING bike_id")) {
          return { rows: applied ? [{ bike_id: row.bike_id ?? null }] : [] };
        }
        return { rows: [] };
      }
      if (text.startsWith("UPDATE bikes SET status = 'offline'")) {
        // Auto-offline follow-up write: `WHERE id = ANY($1) AND status =
        // 'available' AND battery <= $2 RETURNING id, battery`.
        const [ids, threshold] = params as [string[], number];
        const rows: { id: string; battery: number }[] = [];
        for (const id of ids) {
          const row = fake.bikes.get(id);
          if (!row) continue;
          if ((row.status ?? "available") !== "available") continue;
          if ((row.battery ?? 100) > threshold) continue;
          row.status = "offline";
          row.maintenance_reason = "auto:low_battery";
          rows.push({ id, battery: row.battery ?? 0 });
        }
        return { rows };
      }
      if (text.startsWith("UPDATE bikes SET status = 'lost'")) {
        // Theft auto-transition: `WHERE id = $1 AND status NOT IN ('lost',
        // 'archived') RETURNING id`.
        const [id] = params as [string];
        const row = fake.bikes.get(id);
        if (!row || row.status === "lost" || row.status === "archived") return { rows: [] };
        row.status = "lost";
        return { rows: [{ id }] };
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
import { resetMovementAlarmStreak } from "./theft-registry";
import {
  lockAlarmEvents, LOCK_FALL_ALARM, type LockFallAlarmPayload,
  LOCK_MOVEMENT_ALARM, type LockMovementAlarmPayload,
  bikeAutoOfflineEvents, BIKE_AUTO_OFFLINE, type BikeAutoOfflinePayload,
  bikeTheftEvents, BIKE_AUTO_LOST, type BikeAutoLostPayload,
} from "../storage/events";

const IMEI = "861234567890123";
const store = new PgOmniStore();

beforeEach(() => {
  fake.reset();
  // The movement/fall theft streak (theft-registry.ts) is a module-level
  // singleton keyed by IMEI, not part of the `fake` DB — reset it too so
  // tests earlier in this file (which also send code=1/2 alarms for IMEI)
  // never leak a partial streak into a later test.
  resetMovementAlarmStreak(IMEI);
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

describe("persistLockReport fall-alarm event bridge", () => {
  afterEach(() => {
    lockAlarmEvents.removeAllListeners(LOCK_FALL_ALARM);
  });

  it("emits LOCK_FALL_ALARM when alarm code 2 (fall) lands on a lock assigned to a bike", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    const received: LockFallAlarmPayload[] = [];
    lockAlarmEvents.on(LOCK_FALL_ALARM, (payload: LockFallAlarmPayload) => received.push(payload));

    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 5000);

    expect(received).toEqual([{ imei: IMEI, bikeId: "bike-a", at: 5000 }]);
  });

  it("does not emit for other alarm codes (illegal movement / fall_cleared)", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    const received: LockFallAlarmPayload[] = [];
    lockAlarmEvents.on(LOCK_FALL_ALARM, (payload: LockFallAlarmPayload) => received.push(payload));

    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 5000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 6 }, 6000);

    expect(received).toEqual([]);
  });

  it("does not emit when the lock has no bike assigned", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: null });
    const received: LockFallAlarmPayload[] = [];
    lockAlarmEvents.on(LOCK_FALL_ALARM, (payload: LockFallAlarmPayload) => received.push(payload));

    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 5000);

    expect(received).toEqual([]);
  });

  it("does not emit when the report is rejected as stale (ordering guard)", async () => {
    fake.locks.set(IMEI, { last_seen_at: 9000, bike_id: "bike-a" });
    const received: LockFallAlarmPayload[] = [];
    lockAlarmEvents.on(LOCK_FALL_ALARM, (payload: LockFallAlarmPayload) => received.push(payload));

    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 1000);

    expect(received).toEqual([]);
  });
});

describe("persistLockReport movement-alarm event bridge", () => {
  afterEach(() => {
    lockAlarmEvents.removeAllListeners(LOCK_MOVEMENT_ALARM);
  });

  it("emits LOCK_MOVEMENT_ALARM when alarm code 1 (illegal movement) lands on a lock assigned to a bike", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    const received: LockMovementAlarmPayload[] = [];
    lockAlarmEvents.on(LOCK_MOVEMENT_ALARM, (payload: LockMovementAlarmPayload) => received.push(payload));

    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 5000);

    expect(received).toEqual([{ imei: IMEI, bikeId: "bike-a", at: 5000 }]);
  });

  it("does not emit for other alarm codes (fall / fall_cleared)", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    const received: LockMovementAlarmPayload[] = [];
    lockAlarmEvents.on(LOCK_MOVEMENT_ALARM, (payload: LockMovementAlarmPayload) => received.push(payload));

    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 5000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 6 }, 6000);

    expect(received).toEqual([]);
  });

  it("does not emit when the lock has no bike assigned", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: null });
    const received: LockMovementAlarmPayload[] = [];
    lockAlarmEvents.on(LOCK_MOVEMENT_ALARM, (payload: LockMovementAlarmPayload) => received.push(payload));

    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 5000);

    expect(received).toEqual([]);
  });

  it("does not emit when the report is rejected as stale (ordering guard)", async () => {
    fake.locks.set(IMEI, { last_seen_at: 9000, bike_id: "bike-a" });
    const received: LockMovementAlarmPayload[] = [];
    lockAlarmEvents.on(LOCK_MOVEMENT_ALARM, (payload: LockMovementAlarmPayload) => received.push(payload));

    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 1000);

    expect(received).toEqual([]);
  });
});

describe("persistLockReport theft (auto-lost) streak", () => {
  afterEach(() => {
    bikeTheftEvents.removeAllListeners(BIKE_AUTO_LOST);
    resetMovementAlarmStreak(IMEI);
  });

  it("transitions the bike to 'lost' after 6 alarms alternating illegal-movement (code=1) and fall (code=2)", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    fake.bikes.set("bike-a", { last_seen: null, status: "rented" });
    const lostEvents: BikeAutoLostPayload[] = [];
    bikeTheftEvents.on(BIKE_AUTO_LOST, (payload: BikeAutoLostPayload) => lostEvents.push(payload));

    const codes: Array<1 | 2> = [1, 2, 1, 2, 1, 2];
    for (let i = 0; i < codes.length; i++) {
      await store.persistLockReport(IMEI, { type: "alarm", code: codes[i] }, 1000 + i * 1000);
    }

    expect(fake.bikes.get("bike-a")?.status).toBe("lost");
    expect(lostEvents).toEqual([{ bikeId: "bike-a", imei: IMEI, at: 6000 }]);
  });

  it("does not transition before 6 combined movement/fall alarms are reached", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    fake.bikes.set("bike-a", { last_seen: null, status: "rented" });

    for (let i = 0; i < 5; i++) {
      await store.persistLockReport(IMEI, { type: "alarm", code: i % 2 === 0 ? 1 : 2 }, 1000 + i * 1000);
    }

    expect(fake.bikes.get("bike-a")?.status).toBe("rented");
  });

  it("ignores fall_cleared (code=6) reports for the streak — they neither count nor reset it", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    fake.bikes.set("bike-a", { last_seen: null, status: "rented" });

    // 5 movement/fall alarms, then a fall_cleared, then the 6th movement/fall
    // alarm — the fall_cleared must not have reset the streak in between.
    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 1000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 2000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 3000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 4000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 5000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 6 }, 5500);
    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 6000);

    expect(fake.bikes.get("bike-a")?.status).toBe("lost");
  });

  it("resets the streak on any report that is not a code=1/2/6 alarm", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    fake.bikes.set("bike-a", { last_seen: null, status: "rented" });

    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 1000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 2000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 3000);
    // A heartbeat in between breaks the streak — the next 3 alarms alone are
    // not enough to reach the threshold of 6.
    await store.persistLockReport(IMEI, { type: "heartbeat", locked: true, voltageCv: 400, signal: 20 }, 3500);
    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 4000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 1 }, 5000);
    await store.persistLockReport(IMEI, { type: "alarm", code: 2 }, 6000);

    expect(fake.bikes.get("bike-a")?.status).toBe("rented");
  });

  it("never re-transitions a bike an operator has already archived", async () => {
    fake.locks.set(IMEI, { last_seen_at: null, bike_id: "bike-a" });
    fake.bikes.set("bike-a", { last_seen: null, status: "archived" });
    const lostEvents: BikeAutoLostPayload[] = [];
    bikeTheftEvents.on(BIKE_AUTO_LOST, (payload: BikeAutoLostPayload) => lostEvents.push(payload));

    const codes: Array<1 | 2> = [1, 2, 1, 2, 1, 2];
    for (let i = 0; i < codes.length; i++) {
      await store.persistLockReport(IMEI, { type: "alarm", code: codes[i] }, 1000 + i * 1000);
    }

    expect(fake.bikes.get("bike-a")?.status).toBe("archived");
    expect(lostEvents).toEqual([]);
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


describe("applyLiveUpdates auto-offline on low lock battery (rental spec addendum, 2026-09)", () => {
  it("flips an available bike to offline and fires BIKE_AUTO_OFFLINE at the threshold", async () => {
    fake.bikes.set("bike-b", { last_seen: null, status: "available", battery: 50 });
    const onOffline = vi.fn<(p: BikeAutoOfflinePayload) => void>();
    bikeAutoOfflineEvents.on(BIKE_AUTO_OFFLINE, onOffline);
    try {
      await store.applyLiveUpdates([{ bikeId: "bike-b", x: null, y: null, batteryPct: 10, t: 5000 }]);

      expect(fake.bikes.get("bike-b")).toMatchObject({ status: "offline", maintenance_reason: "auto:low_battery" });
      expect(onOffline).toHaveBeenCalledWith(expect.objectContaining({ bikeId: "bike-b", battery: 10 }));
    } finally {
      bikeAutoOfflineEvents.off(BIKE_AUTO_OFFLINE, onOffline);
    }
  });

  it("leaves a bike above the threshold untouched", async () => {
    fake.bikes.set("bike-c", { last_seen: null, status: "available", battery: 50 });
    const onOffline = vi.fn();
    bikeAutoOfflineEvents.on(BIKE_AUTO_OFFLINE, onOffline);
    try {
      await store.applyLiveUpdates([{ bikeId: "bike-c", x: null, y: null, batteryPct: 25, t: 5000 }]);

      expect(fake.bikes.get("bike-c")).toMatchObject({ status: "available" });
      expect(onOffline).not.toHaveBeenCalled();
    } finally {
      bikeAutoOfflineEvents.off(BIKE_AUTO_OFFLINE, onOffline);
    }
  });

  it("never touches a bike that is mid-ride (status = rented) even at 0% battery", async () => {
    fake.bikes.set("bike-d", { last_seen: null, status: "rented", battery: 40 });
    const onOffline = vi.fn();
    bikeAutoOfflineEvents.on(BIKE_AUTO_OFFLINE, onOffline);
    try {
      await store.applyLiveUpdates([{ bikeId: "bike-d", x: null, y: null, batteryPct: 0, t: 5000 }]);

      expect(fake.bikes.get("bike-d")).toMatchObject({ status: "rented" });
      expect(onOffline).not.toHaveBeenCalled();
    } finally {
      bikeAutoOfflineEvents.off(BIKE_AUTO_OFFLINE, onOffline);
    }
  });

  it("does not run the offline check at all when this flush carries no battery reading", async () => {
    fake.bikes.set("bike-e", { last_seen: null, status: "available", battery: 5 });
    const onOffline = vi.fn();
    bikeAutoOfflineEvents.on(BIKE_AUTO_OFFLINE, onOffline);
    try {
      // Position-only report (batteryPct omitted) — this bike's stored battery
      // is already under the threshold, but since it did not report battery in
      // THIS flush, the scoped follow-up write must not pick it up.
      await store.applyLiveUpdates([{ bikeId: "bike-e", x: 10, y: 10, batteryPct: null, t: 5000 }]);

      expect(fake.bikes.get("bike-e")).toMatchObject({ status: "available" });
      expect(onOffline).not.toHaveBeenCalled();
    } finally {
      bikeAutoOfflineEvents.off(BIKE_AUTO_OFFLINE, onOffline);
    }
  });
});

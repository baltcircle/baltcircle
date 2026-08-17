// Persistence for the OMNI lock TCP ingest server.
//
// Split into a narrow `OmniStore` interface plus a Postgres implementation so
// the TCP server can be exercised end-to-end in tests against an in-memory
// fake — the rest of the suite runs without a live Postgres (see
// vitest.config.ts) and this must not change that.
//
// `TelemetryWriter` sits in front of the store and is the reason 100-200 locks
// checking in on a 4-minute cadence do not turn into 100-200 individual
// INSERTs: reports accumulate in memory and land as one multi-row statement per
// flush window.
import type { OmniMessage } from "@shared/omni/protocol";
import { pool } from "../db/bootstrap";

// Keep the public TCP process decoupled from the full Drizzle schema graph: it
// is started before HTTP routes and should only need the constants it owns.
const UNASSIGNED_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const UNASSIGNED_LOCK_MAX_ROWS = 500;

/** One accepted device report, already validated and projected. */
export interface TelemetryRow {
  bikeId: string;
  imei: string;
  /** OMNI command that produced this row (Q0/H0/D0/S5/W0). */
  cmd: string;
  t: number;
  x: number | null;
  y: number | null;
  lat: number | null;
  lng: number | null;
  satellites: number | null;
  hdop: number | null;
  altitudeM: number | null;
  voltageCv: number | null;
  batteryPct: number | null;
  signalLevel: number | null;
  locked: boolean | null;
  alarmCode: number | null;
}

/** Live-state fields worth pushing onto the `bikes` row for the ops map. */
export interface BikeLiveUpdate {
  bikeId: string;
  t: number;
  x?: number;
  y?: number;
  batteryPct?: number;
}

/**
 * Outcome of resolving a connecting IMEI against the pre-provisioned device
 * registry. `authorized: false` is the fail-closed default for anything the
 * registry does not vouch for — an IMEI it has never seen, or one an admin
 * has explicitly decommissioned (audit F-01/F-03/F-09).
 */
export type LockAuthResult =
  | { authorized: true; bikeId: string | null }
  | { authorized: false; reason: "unknown" | "decommissioned" };

export interface OmniStore {
  /** Resolve an IMEI to the bike it is fitted to, or null if unregistered. */
  findBikeIdByImei(imei: string): Promise<string | null>;
  /**
   * Note that an unregistered lock is alive, so an operator can pick it when
   * creating a bike. Recording a sighting never grants the lock access — the
   * caller still closes the socket.
   */
  recordUnassignedLock(imei: string, at: number): Promise<void>;
  insertTelemetry(rows: TelemetryRow[]): Promise<void>;
  applyLiveUpdates(updates: BikeLiveUpdate[]): Promise<void>;
  setLockOnline(imei: string, online: boolean, at: number): Promise<void>;
  /** Clear stale online flags left behind by a previous process. */
  resetAllLocksOffline(): Promise<void>;
  /**
   * Gateway-owned device registry projection. MUST be read-only with respect
   * to authorisation: a row is never created here, only looked up and its
   * connectivity bookkeeping refreshed. Provisioning a device is an explicit
   * admin action (`POST /api/admin/locks`) — dialling in must never be
   * sufficient on its own to grant a socket access to the fleet. Optional
   * during the transition from the original bike.lock_imei ingest; production
   * PgOmniStore always implements it and test doubles can stay focused on TCP
   * framing.
   */
  resolveLock?(imei: string, at: number): Promise<LockAuthResult>;
  persistLockReport?(imei: string, message: OmniMessage, at: number): Promise<void>;
  markLocksOfflineBefore?(before: number): Promise<void>;
}

const TELEMETRY_COLUMNS = [
  "bike_id", "imei", "cmd", "t", "x", "y", "lat", "lng",
  "satellites", "hdop", "altitude_m", "voltage_cv", "battery_pct",
  "signal_level", "locked", "alarm_code",
] as const;

/** Rows per INSERT, keeping columns x rows under Postgres' 65535 parameter cap. */
const MAX_INSERT_ROWS = Math.floor(65535 / TELEMETRY_COLUMNS.length);

export class PgOmniStore implements OmniStore {
  async findBikeIdByImei(imei: string): Promise<string | null> {
    const rows = (await pool.query<{ bike_id: string | null }>(
      "SELECT bike_id FROM locks WHERE imei = $1 LIMIT 1",
      [imei],
    )).rows;
    return rows[0]?.bike_id ?? null;
  }

  /**
   * Fail-closed device authorisation (audit F-01/F-03/F-09). Looks up a
   * pre-provisioned `locks` row — it never creates one. An IMEI with no row
   * at all, or whose row is `decommissioned`, is rejected outright; nothing
   * else about the connection is touched.
   *
   * The update re-checks `status != 'decommissioned'` instead of trusting the
   * status read a moment earlier, so a decommission that lands concurrently
   * with a device dialling in still closes the socket rather than losing the
   * race and authorising it.
   */
  async resolveLock(imei: string, at: number): Promise<LockAuthResult> {
    const existing = await pool.query<{ bike_id: string | null; status: string }>(
      "SELECT bike_id, status FROM locks WHERE imei = $1 LIMIT 1",
      [imei],
    );
    const row = existing.rows[0];
    if (!row) return { authorized: false, reason: "unknown" };
    if (row.status === "decommissioned") return { authorized: false, reason: "decommissioned" };

    const updated = await pool.query<{ bike_id: string | null }>(
      `UPDATE locks SET status = 'active', last_seen_at = GREATEST(COALESCE(last_seen_at, 0), $2), updated_at = $2
       WHERE imei = $1 AND status != 'decommissioned'
       RETURNING bike_id`,
      [imei, at],
    );
    if (!updated.rows[0]) return { authorized: false, reason: "decommissioned" };
    return { authorized: true, bikeId: updated.rows[0].bike_id };
  }

  async persistLockReport(imei: string, message: OmniMessage, at: number): Promise<void> {
    const base = `status = CASE WHEN status = 'decommissioned' THEN status ELSE 'active' END,
      last_seen_at = GREATEST(COALESCE(last_seen_at, 0), $2), updated_at = $2`;
    const voltage = (cv: number) => cv / 100;
    switch (message.type) {
      case "checkin":
        await pool.query(`UPDATE locks SET ${base}, last_battery_voltage = $3 WHERE imei = $1`,
          [imei, at, voltage(message.voltageCv)]);
        return;
      case "heartbeat":
        await pool.query(`UPDATE locks SET ${base}, last_lock_state = $3,
          last_battery_voltage = $4, last_signal_strength = $5 WHERE imei = $1`,
          [imei, at, message.locked ? "locked" : "unlocked", voltage(message.voltageCv), message.signal]);
        return;
      case "position":
        if (message.valid && message.fix) {
          await pool.query(`UPDATE locks SET ${base}, last_latitude = $3,
            last_longitude = $4, last_location_at = $2 WHERE imei = $1`,
            [imei, at, message.fix.lat, message.fix.lng]);
        } else {
          await pool.query(`UPDATE locks SET ${base} WHERE imei = $1`, [imei, at]);
        }
        return;
      case "alarm": {
        const alarmType = ({ 1: "illegal_movement", 2: "fall", 6: "fall_cleared" } as Record<number, string>)[message.code] ?? String(message.code);
        await pool.query(`UPDATE locks SET ${base}, last_alarm_type = $3, last_alarm_at = $2 WHERE imei = $1`,
          [imei, at, alarmType]);
        return;
      }
      case "lockReport": {
        await pool.query(`UPDATE locks SET ${base}, last_lock_state = 'locked' WHERE imei = $1`, [imei, at]);
        // Audit F-04: this is a device-autonomous report of a physical close
        // that already happened — there is no way for the server to have
        // prevented it. If a ride is still "active" on this lock's bike, the
        // rider closed the lock without the app ending the ride; flag it for
        // ops (dashboard/admin API) without touching ride/bike lifecycle.
        // `physically_locked_at IS NULL` keeps the FIRST occurrence, not the
        // latest, so the discrepancy's start time is preserved.
        const bikeId = await this.findBikeIdByImei(imei);
        if (bikeId) {
          await pool.query(
            `UPDATE rides SET physically_locked_at = $1
             WHERE bike_id = $2 AND status = 'active' AND physically_locked_at IS NULL`,
            [at, bikeId],
          );
        }
        return;
      }
      case "firmware":
        await pool.query(`UPDATE locks SET ${base}, firmware_version = $3, device_type_code = $4 WHERE imei = $1`,
          [imei, at, message.firmwareVersion, message.deviceTypeCode]);
        return;
      case "iccid":
        await pool.query(`UPDATE locks SET ${base}, sim_iccid = $3 WHERE imei = $1`, [imei, at, message.simIccid]);
        return;
      case "mac":
        await pool.query(`UPDATE locks SET ${base}, mac_address = $3 WHERE imei = $1`, [imei, at, message.macAddress]);
        return;
      default:
        await pool.query(`UPDATE locks SET ${base} WHERE imei = $1`, [imei, at]);
    }
  }

  /**
   * Upsert a sighting of an unregistered lock, keeping the table small.
   *
   * Expired rows are dropped first so the cap is self-healing: capping alone
   * would let a burst of spoofed IMEIs fill every slot and permanently hide the
   * next real lock an operator powers on. The insert is guarded by the cap in
   * the same statement (rather than a read-then-write) so concurrent
   * connections cannot race past it; an IMEI already present always refreshes,
   * because a known lock must not be evicted by a full table.
   */
  async recordUnassignedLock(imei: string, at: number): Promise<void> {
    await pool.query("DELETE FROM unassigned_locks WHERE last_seen < $1", [
      at - UNASSIGNED_LOCK_TTL_MS,
    ]);
    await pool.query(
      `INSERT INTO unassigned_locks (imei, first_seen, last_seen)
       SELECT $1, $2, $2
        WHERE EXISTS (SELECT 1 FROM unassigned_locks WHERE imei = $1)
           OR (SELECT count(*) FROM unassigned_locks) < $3
       ON CONFLICT (imei) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
      [imei, at, UNASSIGNED_LOCK_MAX_ROWS],
    );
  }

  async insertTelemetry(rows: TelemetryRow[]): Promise<void> {
    // Postgres accepts at most 65535 bind parameters per statement, so a batch
    // is split rather than trusted to fit — OMNI_MAX_BATCH_ROWS is operator
    // config and a generous value must degrade into more statements, not into a
    // rejected batch (which TelemetryWriter would then drop).
    for (let i = 0; i < rows.length; i += MAX_INSERT_ROWS) {
      await this.insertChunk(rows.slice(i, i + MAX_INSERT_ROWS));
    }
  }

  private async insertChunk(rows: TelemetryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const params: unknown[] = [];
    const tuples = rows.map((r) => {
      const values = [
        r.bikeId, r.imei, r.cmd, r.t, r.x, r.y, r.lat, r.lng,
        r.satellites, r.hdop, r.altitudeM, r.voltageCv, r.batteryPct,
        r.signalLevel, r.locked, r.alarmCode,
      ];
      const placeholders = values.map((v) => `$${params.push(v)}`);
      return `(${placeholders.join(",")})`;
    });
    await pool.query(
      `INSERT INTO bike_telemetry (${TELEMETRY_COLUMNS.join(",")}) VALUES ${tuples.join(",")}`,
      params,
    );
  }

  /**
   * Push the newest position/battery onto the `bikes` rows in one statement.
   *
   * Note the column swap: this codebase stores abstract map `y` in `bikes.lat`
   * and `x` in `bikes.lng` (see shared/geo.ts realToMap and the existing
   * storage layer). COALESCE keeps a field untouched when a report did not
   * carry it — a heartbeat updates battery but must not blank the position.
   *
   * `idle_hours` is deliberately NOT reset here. A lock heartbeats every ~4
   * minutes whether or not the bike moves (protocol §1.3.2), so zeroing idle
   * time on every report would permanently hide idle bikes from the ops view.
   */
  async applyLiveUpdates(updates: BikeLiveUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const params: unknown[] = [];
    const tuples = updates.map((u) => {
      const cells = [
        `$${params.push(u.bikeId)}::text`,
        `$${params.push(u.x ?? null)}::double precision`,
        `$${params.push(u.y ?? null)}::double precision`,
        `$${params.push(u.batteryPct ?? null)}::integer`,
        `$${params.push(u.t)}::bigint`,
      ];
      return `(${cells.join(",")})`;
    });
    await pool.query(
      `UPDATE bikes AS b SET
         lng = COALESCE(v.x, b.lng),
         lat = COALESCE(v.y, b.lat),
         battery = COALESCE(v.battery_pct, b.battery),
         last_seen = GREATEST(b.last_seen, v.t),
         lock_last_seen = GREATEST(COALESCE(b.lock_last_seen, 0), v.t)
       FROM (VALUES ${tuples.join(",")}) AS v(bike_id, x, y, battery_pct, t)
       WHERE b.id = v.bike_id`,
      params,
    );
  }

  /**
   * Flip a lock's online flag.
   *
   * The `at` guard makes the write last-writer-wins by device time rather than
   * by arrival: a reconnect races the teardown of the socket it replaced, and
   * those two statements run on different pool connections, so the stale
   * socket's "offline" can otherwise land after the new socket's "online" and
   * leave a live lock reading offline until its next reconnect.
   */
  async setLockOnline(imei: string, online: boolean, at: number): Promise<void> {
    await pool.query(
      `UPDATE locks SET status = CASE WHEN status = 'decommissioned' THEN status ELSE $2 END,
        last_seen_at = CASE WHEN $2 = 'active' THEN GREATEST(COALESCE(last_seen_at, 0), $3) ELSE last_seen_at END,
        updated_at = $3 WHERE imei = $1`,
      [imei, online ? "active" : "offline", at],
    );
    await pool.query(
      `UPDATE bikes SET lock_online = $2, lock_last_seen = $3
        WHERE lock_imei = $1 AND (lock_last_seen IS NULL OR lock_last_seen <= $3)`,
      [imei, online, at],
    );
  }

  async resetAllLocksOffline(): Promise<void> {
    await pool.query(`UPDATE locks SET status = 'offline', updated_at = $1 WHERE status = 'active'`, [Date.now()]);
    await pool.query("UPDATE bikes SET lock_online = FALSE WHERE lock_online = TRUE");
  }

  async markLocksOfflineBefore(before: number): Promise<void> {
    await pool.query(
      `UPDATE locks SET status = 'offline', updated_at = $2
        WHERE status = 'active' AND last_seen_at IS NOT NULL AND last_seen_at < $1`,
      [before, Date.now()],
    );
  }
}

// ---------------------------------------------------------------------------
// Write batching
// ---------------------------------------------------------------------------

export interface TelemetryWriterOptions {
  /** Flush at least this often, even if the batch is small. */
  flushIntervalMs?: number;
  /** Flush immediately once this many rows are queued. */
  maxBatchRows?: number;
  /** Drop new rows past this depth rather than growing without bound. */
  maxQueueRows?: number;
  onError?: (err: unknown, droppedRows: number) => void;
  onOverflow?: (droppedRows: number) => void;
}

/**
 * Buffers telemetry and flushes it as batched statements.
 *
 * Bike live-state updates are coalesced per bike (only the newest report in a
 * window matters for "where is this bike now"), while telemetry rows are all
 * retained because they are the ride-track history.
 */
export class TelemetryWriter {
  private queue: TelemetryRow[] = [];
  private live = new Map<string, BikeLiveUpdate>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;

  private readonly flushIntervalMs: number;
  private readonly maxBatchRows: number;
  private readonly maxQueueRows: number;

  constructor(
    private readonly store: OmniStore,
    private readonly opts: TelemetryWriterOptions = {},
  ) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 2_000;
    this.maxBatchRows = opts.maxBatchRows ?? 500;
    this.maxQueueRows = opts.maxQueueRows ?? 20_000;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  add(row: TelemetryRow, live?: BikeLiveUpdate): void {
    if (this.closed) return;

    if (this.queue.length >= this.maxQueueRows) {
      // Postgres is unreachable or too slow. Shedding the newest report is
      // better than letting the process OOM; the next one is 4 minutes away.
      this.opts.onOverflow?.(1);
      return;
    }
    this.queue.push(row);

    if (live) {
      const prev = this.live.get(live.bikeId);
      this.live.set(live.bikeId, prev && prev.t > live.t ? prev : { ...prev, ...live });
    }

    if (this.queue.length >= this.maxBatchRows) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Write everything queued. Concurrent calls share the in-flight flush. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0 && this.live.size === 0) return Promise.resolve();

    const rows = this.queue;
    const live = Array.from(this.live.values());
    this.queue = [];
    this.live = new Map();

    this.flushing = (async () => {
      try {
        await this.store.insertTelemetry(rows);
        await this.store.applyLiveUpdates(live);
      } catch (err) {
        // The batch is gone either way — telemetry is lossy by nature and
        // retrying risks unbounded growth behind a broken database.
        this.opts.onError?.(err, rows.length);
      } finally {
        this.flushing = null;
      }
    })();

    return this.flushing;
  }

  async close(): Promise<void> {
    this.closed = true;
    // A flush already in flight took a snapshot of the queue, so rows added
    // after it started are still pending. Drain until nothing is left, or a
    // deploy would silently discard the last reports it accepted. `closed`
    // blocks new arrivals, so this terminates.
    while (this.flushing || this.queue.length > 0 || this.live.size > 0) {
      await this.flushing;
      await this.flush();
    }
  }
}

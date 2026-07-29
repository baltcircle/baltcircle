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
import { pool } from "../db/bootstrap";

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

export interface OmniStore {
  /** Resolve an IMEI to the bike it is fitted to, or null if unregistered. */
  findBikeIdByImei(imei: string): Promise<string | null>;
  insertTelemetry(rows: TelemetryRow[]): Promise<void>;
  applyLiveUpdates(updates: BikeLiveUpdate[]): Promise<void>;
  setLockOnline(imei: string, online: boolean, at: number): Promise<void>;
  /** Clear stale online flags left behind by a previous process. */
  resetAllLocksOffline(): Promise<void>;
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
    const rows = (await pool.query<{ id: string }>(
      "SELECT id FROM bikes WHERE lock_imei = $1 LIMIT 1",
      [imei],
    )).rows;
    return rows.length > 0 ? rows[0].id : null;
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
      `UPDATE bikes SET lock_online = $2, lock_last_seen = $3
        WHERE lock_imei = $1 AND (lock_last_seen IS NULL OR lock_last_seen <= $3)`,
      [imei, online, at],
    );
  }

  async resetAllLocksOffline(): Promise<void> {
    await pool.query("UPDATE bikes SET lock_online = FALSE WHERE lock_online = TRUE");
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

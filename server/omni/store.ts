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
import {
  haversineM, MAX_PLAUSIBLE_GPS_JUMP_M, MAX_ACCEPTABLE_HDOP, LOW_BATTERY_AUTO_OFFLINE_THRESHOLD,
} from "@shared/geo";
import { pool } from "../db/bootstrap";
import { logger } from "../logger";
import { consumePendingPause } from "./pause-registry";
import { consumePendingEnd } from "./pending-end-registry";
import { consumePendingGpsRefresh } from "./gps-refresh-registry";
import {
  recordMovementAlarm, resetMovementAlarmStreak, MOVEMENT_ALARM_THEFT_THRESHOLD,
} from "./theft-registry";
import {
  rideEvents, lockGpsEvents, LOCK_GPS_REFRESHED, type LockGpsRefreshedPayload,
  pendingEndEvents, LOCK_CLOSED_FOR_END, type LockClosedForEndPayload,
  lockAlarmEvents, LOCK_FALL_ALARM, type LockFallAlarmPayload,
  LOCK_MOVEMENT_ALARM, type LockMovementAlarmPayload,
  bikeAutoOfflineEvents, BIKE_AUTO_OFFLINE,
  bikeTheftEvents, BIKE_AUTO_LOST, type BikeAutoLostPayload,
  bikeEvents, BIKE_EVENT_CHANNEL,
} from "../storage/events";


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
  /**
   * Returns `false` when a "position" message's fix was rejected as an
   * implausible jump (see MAX_PLAUSIBLE_GPS_JUMP_M) and therefore NOT written
   * to locks.last_latitude/last_longitude — the caller (server.ts `record()`)
   * uses this to also withhold the fix from the bikes.lat/lng live update, so
   * a bad fix cannot corrupt one "current position" column while the other
   * stays correct. Always `true` for non-position message types and for a
   * position message that was written normally (including the always-
   * accepted first-ever fix for a lock).
   */
  persistLockReport?(imei: string, message: OmniMessage, at: number): Promise<boolean>;
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

  async persistLockReport(imei: string, message: OmniMessage, at: number): Promise<boolean> {
    // Audit F-08: reports for one IMEI are decoded in arrival order but their
    // async DB writes race in the pool, so an earlier (older) report's
    // UPDATE can complete after a later (newer) one's. GREATEST() alone kept
    // last_seen_at monotonic while every other field — lock state, GPS fix,
    // battery, alarm — was still applied unconditionally, so a stale write
    // landing last could silently overwrite fresher state while last_seen_at
    // kept ticking forward. Guarding the WHOLE row update on "this report is
    // not older than what is already stored" makes each UPDATE atomic: a
    // stale report is a no-op instead of a partial overwrite, and
    // last_seen_at can just be set to $2 directly — the guard already
    // proves $2 is the newest value.
    const NEWEST_REPORT_GUARD = "AND (last_seen_at IS NULL OR last_seen_at <= $2)";
    const base = `status = CASE WHEN status = 'decommissioned' THEN status ELSE 'active' END,
      last_seen_at = $2, updated_at = $2`;
    const voltage = (cv: number) => cv / 100;
    // Theft-detection streak (see theft-registry.ts header): any report that
    // is NOT itself a code=1 ("illegal movement") alarm means this lock did
    // not re-report movement this time — whatever triggered the streak has
    // stopped, so reset it. The "alarm" branch below re-increments instead
    // when it IS code=1.
    if (!(message.type === "alarm" && message.code === 1)) {
      resetMovementAlarmStreak(imei);
    }
    switch (message.type) {
      case "checkin":
        await pool.query(`UPDATE locks SET ${base}, last_battery_voltage = $3 WHERE imei = $1 ${NEWEST_REPORT_GUARD}`,
          [imei, at, voltage(message.voltageCv)]);
        return true;
      case "heartbeat":
        await pool.query(`UPDATE locks SET ${base}, last_lock_state = $3,
          last_battery_voltage = $4, last_signal_strength = $5 WHERE imei = $1 ${NEWEST_REPORT_GUARD}`,
          [imei, at, message.locked ? "locked" : "unlocked", voltage(message.voltageCv), message.signal]);
        return true;
      case "position":
        if (message.valid && message.fix) {
          // Accuracy gate BEFORE the jump check below: cheaper (no extra
          // SELECT) and catches a class of bad fix the jump check can't —
          // a lock sitting still can report a fix that hasn't physically
          // "jumped" anywhere yet is still too imprecise to trust (see
          // MAX_ACCEPTABLE_HDOP). Same no-op outcome as a rejected jump:
          // last_seen_at advances, the position columns don't.
          if (message.fix.hdop != null && message.fix.hdop > MAX_ACCEPTABLE_HDOP) {
            logger.warn(
              { imei, hdop: message.fix.hdop, satellites: message.fix.satellites },
              "omni: rejected low-accuracy GPS fix (hdop exceeds MAX_ACCEPTABLE_HDOP)",
            );
            await pool.query(`UPDATE locks SET ${base} WHERE imei = $1 ${NEWEST_REPORT_GUARD}`, [imei, at]);
            return false;
          }
          // Sanity-bound the fix against the lock's own last stored position
          // before trusting it (production incident, 2026-08-23: a single
          // structurally-valid-but-wrong "flyaway" fix — passes nmeaToDecimal's
          // +/-90/+/-180 bounds check but is physically hundreds of km off —
          // got stored verbatim, corrupted bikes.lat/lng via applyLiveUpdates,
          // and blocked ride start via the radius gate in server/storage/ride.ts,
          // since both read this same last_latitude/last_longitude). Best-effort
          // read-then-decide: a concurrent write for the same imei landing
          // between the SELECT and this UPDATE is the same class of race the
          // NEWEST_REPORT_GUARD above already tolerates for telemetry, not a
          // financial/safety-critical path.
          // node-postgres does not globally parse NUMERIC (OID 1700) to a JS
          // number (only BIGINT/OID 20 is, in db/client.ts) — it comes back as
          // a string here, so coerce explicitly before doing arithmetic.
          const prevRow = (await pool.query<{ last_latitude: string | null; last_longitude: string | null }>(
            "SELECT last_latitude, last_longitude FROM locks WHERE imei = $1",
            [imei],
          )).rows[0];
          const prevLat = prevRow?.last_latitude != null ? Number(prevRow.last_latitude) : null;
          const prevLng = prevRow?.last_longitude != null ? Number(prevRow.last_longitude) : null;
          const jumpM = prevLat != null && prevLng != null
            ? haversineM(prevLat, prevLng, message.fix.lat, message.fix.lng)
            : null;
          if (jumpM !== null && jumpM > MAX_PLAUSIBLE_GPS_JUMP_M) {
            logger.warn(
              {
                imei, jumpM: Math.round(jumpM),
                prevLat, prevLng,
                newLat: message.fix.lat, newLng: message.fix.lng,
              },
              "omni: rejected implausible GPS fix (jump exceeds MAX_PLAUSIBLE_GPS_JUMP_M)",
            );
            await pool.query(`UPDATE locks SET ${base} WHERE imei = $1 ${NEWEST_REPORT_GUARD}`, [imei, at]);
            return false;
          }
          const result = await pool.query(`UPDATE locks SET ${base}, last_latitude = $3,
            last_longitude = $4, last_location_at = $2 WHERE imei = $1 ${NEWEST_REPORT_GUARD}`,
            [imei, at, message.fix.lat, message.fix.lng]);
          // Opportunistic GPS-refresh (see gps-refresh-registry.ts): a status
          // change on a parked bike arms a short D1 burst because idle
          // heartbeats carry no position at all. Consume the expectation only
          // on a fix that actually landed (rowCount guards against an
          // out-of-order report NEWEST_REPORT_GUARD just rejected —
          // propagating a stale fix to bikes.lat/lng would be worse than
          // waiting for the burst window to catch a genuinely newer one).
          // Emitted so bikes.lat/lng (owned by the storage layer, not this
          // Drizzle-free module) can pick it up via lockGpsEvents.
          const armed = (result.rowCount ?? 0) > 0 ? consumePendingGpsRefresh(imei) : null;
          if (armed) {
            lockGpsEvents.emit(LOCK_GPS_REFRESHED, {
              imei, bikeId: armed.bikeId, lat: message.fix.lat, lng: message.fix.lng,
            } satisfies LockGpsRefreshedPayload);
          }
        } else {
          await pool.query(`UPDATE locks SET ${base} WHERE imei = $1 ${NEWEST_REPORT_GUARD}`, [imei, at]);
        }
        return true;
      case "alarm": {
        const alarmType = ({ 1: "illegal_movement", 2: "fall", 6: "fall_cleared" } as Record<number, string>)[message.code] ?? String(message.code);
        const { rows } = await pool.query<{ bike_id: string | null }>(
          `UPDATE locks SET ${base}, last_alarm_type = $3, last_alarm_at = $2 WHERE imei = $1 ${NEWEST_REPORT_GUARD} RETURNING bike_id`,
          [imei, at, alarmType],
        );
        // Fall/illegal-movement alarms feed the fleet-dashboard alert (see
        // storage/events.ts header) — best-effort, never blocks telemetry
        // ingestion. Skipped when the lock isn't currently assigned to a bike.
        if (alarmType === "fall" && rows[0]?.bike_id) {
          const payload: LockFallAlarmPayload = { imei, bikeId: rows[0].bike_id, at };
          lockAlarmEvents.emit(LOCK_FALL_ALARM, payload);
        } else if (alarmType === "illegal_movement" && rows[0]?.bike_id) {
          const payload: LockMovementAlarmPayload = { imei, bikeId: rows[0].bike_id, at };
          lockAlarmEvents.emit(LOCK_MOVEMENT_ALARM, payload);

          // Auto-"lost" (theft): 6 consecutive code=1 reports with no reset
          // in between (bike-status lifecycle spec, 2026-09) — promote the
          // per-alarm alert above into an actual status transition. Guarded
          // to never re-fire on a bike already "lost"/"archived" (idempotent
          // if the streak somehow keeps climbing past the threshold, and
          // never resurrects/relabels a bike an operator has archived).
          const streak = recordMovementAlarm(imei);
          if (streak >= MOVEMENT_ALARM_THEFT_THRESHOLD) {
            const lost = await pool.query<{ id: string }>(
              `UPDATE bikes SET status = 'lost'
               WHERE id = $1 AND status NOT IN ('lost', 'archived')
               RETURNING id`,
              [rows[0].bike_id],
            );
            if (lost.rows.length > 0) {
              resetMovementAlarmStreak(imei);
              bikeEvents.emit(BIKE_EVENT_CHANNEL);
              bikeTheftEvents.emit(BIKE_AUTO_LOST, { bikeId: rows[0].bike_id, at } satisfies BikeAutoLostPayload);
            }
          }
        }
        return true;
      }
      case "lockReport": {
        await pool.query(`UPDATE locks SET ${base}, last_lock_state = 'locked' WHERE imei = $1 ${NEWEST_REPORT_GUARD}`, [imei, at]);

        // End feature: a rider taps "Завершить" and the app tells them to close
        // the lock; the actual settlement only runs on THIS report, via the
        // event bridge (this module stays Drizzle-free — see file header),
        // since ending is the full transactional endRide(), not a raw UPDATE
        // like pause below. Checked BEFORE the pause check — requestEndRide
        // clears any stale pending pause on the same lock when it arms, so
        // the two are mutually exclusive in practice, but end takes priority
        // if both were somehow armed.
        //
        // Also flags physically_locked_at (same column F-04 uses below) even
        // though this closure is expected, not anomalous: if the eventual
        // storage.endRide() settlement fails (e.g. stale lock GPS — see its
        // geofence gate), the rider's retried "завершить" tap must be able to
        // fast-path straight to endRide() via requestEndRide's
        // physicallyLockedAt check instead of re-arming and waiting forever
        // for a second closure report that will never come (the lock is
        // already closed and won't report again until it's reopened).
        const armedEnd = consumePendingEnd(imei);
        if (armedEnd) {
          pendingEndEvents.emit(LOCK_CLOSED_FOR_END, {
            rideId: armedEnd.rideId, userId: armedEnd.userId, imei,
          } satisfies LockClosedForEndPayload);
          const bikeIdForEnd = await this.findBikeIdByImei(imei);
          if (bikeIdForEnd) {
            await pool.query(
              `UPDATE rides SET physically_locked_at = $1
               WHERE bike_id = $2 AND status = 'active' AND physically_locked_at IS NULL`,
              [at, bikeIdForEnd],
            );
          }
          return true;
        }

        // Pause feature: a rider taps "Пауза" and the app tells them to close
        // the lock; the actual pause only activates on THIS report, once the
        // closure really happened (server can't command a close, only await
        // one — see pause-registry.ts). Consuming here means this expected
        // closure must NOT also fall through to the F-04 anomaly flag below.
        const armedPause = consumePendingPause(imei);
        if (armedPause) {
          const updated = await pool.query<{ user_id: string }>(
            `UPDATE rides SET paused_at = $1
             WHERE id = $2 AND status = 'active' AND paused_at IS NULL
             RETURNING user_id`,
            [at, armedPause.rideId],
          );
          if (updated.rows[0]) {
            rideEvents.emit(updated.rows[0].user_id, "point");
            return true;
          }
          // Ride no longer active/already paused by the time the report landed
          // (e.g. rider ended the ride while the closure was in flight) — fall
          // through to the normal F-04 bookkeeping below, since this closure is
          // then just an ordinary physical-lock event again.
        }

        // Audit F-04 / auto-pause: this is a device-autonomous report of a
        // physical close that already happened — there is no way for the
        // server to have prevented it, and (unlike the two branches above)
        // nothing was armed for it. If a ride is still "active" on this
        // lock's bike, the rider closed the lock without tapping "Пауза" —
        // and there is no other way to close an OMNI lock (no server-side
        // close command exists, see this file's header). Leaving the ride
        // merely "active" here used to strand the rider: resumeRide() (the
        // only code path that sends an unlock command besides startRide) is
        // reachable only from a PAUSED ride, so an active-but-physically-
        // locked bike could never be reopened from the app (production bug).
        // Auto-pausing here closes that gap by reusing the exact same
        // paused_at column and semantics as an app-driven pause: same
        // free-grace billing credit on resume, same "Продолжить" button,
        // same UI — the client already renders any pausedAt regardless of
        // its source (see use-active-ride-stream.tsx). It's a single atomic
        // UPDATE, not two, so there's no window where physically_locked_at
        // is set but paused_at isn't (or vice-versa) if a settlement races.
        //
        // physically_locked_at is set in the SAME statement — COALESCE keeps
        // the first occurrence (same one-shot semantics the old code had) —
        // so requestEndRide's fast path can still skip re-arming if the
        // rider taps "Завершить" while the lock is still closed from this
        // exact event. `paused_at IS NULL` in the WHERE (rather than
        // `physically_locked_at IS NULL`) is what makes this idempotent: a
        // duplicate/retransmitted L1 for a lock that never reopened matches
        // zero rows the second time, so it can't double-emit or reset a
        // rider-driven resume that already happened in between.
        //
        // resumeRide() clears physically_locked_at again on a real resume,
        // since the lock reopens then — a LATER "Завершить" tap must wait
        // for a fresh closure report instead of fast-pathing on this now-
        // stale flag while the lock might still be open.
        const bikeId = await this.findBikeIdByImei(imei);
        if (bikeId) {
          const updated = await pool.query<{ id: number; user_id: string }>(
            `UPDATE rides SET
               physically_locked_at = COALESCE(physically_locked_at, $1),
               paused_at = $1
             WHERE bike_id = $2 AND status = 'active' AND paused_at IS NULL
             RETURNING id, user_id`,
            [at, bikeId],
          );
          if (updated.rows[0]) rideEvents.emit(updated.rows[0].user_id, "point");
        }
        return true;
      }
      case "firmware":
        await pool.query(`UPDATE locks SET ${base}, firmware_version = $3, device_type_code = $4 WHERE imei = $1 ${NEWEST_REPORT_GUARD}`,
          [imei, at, message.firmwareVersion, message.deviceTypeCode]);
        return true;
      case "iccid":
        await pool.query(`UPDATE locks SET ${base}, sim_iccid = $3 WHERE imei = $1 ${NEWEST_REPORT_GUARD}`, [imei, at, message.simIccid]);
        return true;
      case "mac":
        await pool.query(`UPDATE locks SET ${base}, mac_address = $3 WHERE imei = $1 ${NEWEST_REPORT_GUARD}`, [imei, at, message.macAddress]);
        return true;
      default:
        await pool.query(`UPDATE locks SET ${base} WHERE imei = $1 ${NEWEST_REPORT_GUARD}`, [imei, at]);
        return true;
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
    // Audit F-08: same reordering hazard as persistLockReport — flushes are
    // batched every writer flush interval and their queries can complete out
    // of program order, so an older buffered position/battery reading must
    // not be allowed to overwrite a newer one that already landed. Guarding
    // on "this row's t is not older than the bike's current last_seen" makes
    // the update a no-op for a stale row instead of a partial overwrite, so
    // last_seen/lock_last_seen can be set to v.t directly.
    await pool.query(
      `UPDATE bikes AS b SET
         lng = COALESCE(v.x, b.lng),
         lat = COALESCE(v.y, b.lat),
         battery = COALESCE(v.battery_pct, b.battery),
         last_seen = v.t,
         lock_last_seen = v.t
       FROM (VALUES ${tuples.join(",")}) AS v(bike_id, x, y, battery_pct, t)
       WHERE b.id = v.bike_id AND (b.last_seen IS NULL OR b.last_seen <= v.t)`,
      params,
    );

    // Auto-offline (rental spec addendum, 2026-09): only bikes that actually
    // reported a battery reading in this flush can have newly crossed the
    // threshold, so scope the follow-up write to just those ids instead of
    // re-scanning the whole fleet every flush interval. `status = 'available'`
    // in the WHERE clause is what keeps this from ever touching a bike
    // mid-ride — a rented bike's battery dropping to/below the threshold is
    // handled at ride end instead (server/storage/ride.ts), never here.
    // Deliberately does NOT call sendUnlockCommand or any lock command: unlike
    // the operator-initiated moves in server/http/catalog.ts's
    // MOVEMENT_ALARM_SUPPRESSED_STATUSES (which excludes "offline" precisely
    // so an automatic low-battery transition never pops the shackle open),
    // this path never opens the lock.
    const batteryReportedIds = updates.filter((u) => u.batteryPct != null).map((u) => u.bikeId);
    if (batteryReportedIds.length === 0) return;
    const offlined = await pool.query(
      `UPDATE bikes SET status = 'offline', maintenance_reason = 'auto:low_battery'
       WHERE id = ANY($1::text[]) AND status = 'available' AND battery <= $2
       RETURNING id, battery`,
      [batteryReportedIds, LOW_BATTERY_AUTO_OFFLINE_THRESHOLD],
    );
    if (offlined.rows.length === 0) return;
    bikeEvents.emit(BIKE_EVENT_CHANNEL);
    const at = Date.now();
    for (const row of offlined.rows as { id: string; battery: number }[]) {
      bikeAutoOfflineEvents.emit(BIKE_AUTO_OFFLINE, { bikeId: row.id, battery: row.battery, at });
    }
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

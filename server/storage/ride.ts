import { bikes, rides, payments, parkings, ridePoints, users, locks } from "@shared/schema";
import type { Ride, AdminRide, User, Parking, Bike, Lock } from "@shared/schema";
import { eq, sql, and, desc, asc, inArray, count } from "drizzle-orm";
import {
  TARIFFS, tariffPriceKopecks, tariffDurationMs, realToMap,
  findNearestParkingWithinRadius, findNearestParkingWithinRadiusFromRealCoords,
  LOCK_GPS_LIVE_MS, RIDE_GPS_TRACKING_INTERVAL_SECONDS, PAUSE_ARM_TTL_MS,
} from "@shared/geo";
import { computeOverage, finalRideCost, formatKopecksAsRubles } from "@shared/billing";
import { pendingPauseCreditMs } from "@shared/pause";
import { sendToUserAsync } from "../push";
import { getLockGateway } from "../omni/gateway";
import { registerPendingPause, clearPendingPause } from "../omni/pause-registry";
import { log } from "../logger";
import { db, pool } from "../db/bootstrap";
import { rideEvents } from "./events";
import type { RideEventReason } from "./events";
import type { Constructor } from "./mixin";
import type { IRideStorage } from "./interfaces";

export function RideMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IRideStorage {
    // Physically sat with the Lock domain in the pre-refactor monolith (and,
    // through Stage 2, in the composition root) but is semantically
    // Ride-domain — returns a Ride. Kept here rather than in lock.ts.
    /**
     * The current active ride on a bike, if any (audit F-07). Used to stop the
     * admin manual-unlock endpoint from physically opening a bike that is
     * mid-ride for a different rider unless the operator explicitly forces it.
     */
    async getActiveRideForBike(bikeId: string): Promise<Ride | undefined> {
      return (await db.select().from(rides)
        .where(and(eq(rides.bikeId, bikeId), eq(rides.status, "active")))
        .limit(1))[0] as Ride | undefined;
    }

    // ---- ride GPS points (append-only, avoids O(N^2) track rewrites) ----
    // Live points go to their own ride_points table so each appended point is a
    // single INSERT instead of parsing + re-stringifying the whole track JSON.
    // rides.track stays the canonical stored track, finalised once in endRide.
    // (The old standalone insertRidePoint() helper was folded into
    // appendRidePoint()'s transaction — see the audit note there.)

    // Audit HIGH #15: this used to always run on the global `pool` (a plain
    // pool.query), even when called from inside an already-open `db.transaction`
    // (endRide below). A raw pool.query grabs a SEPARATE connection instead of
    // reusing the transaction's own client, so it can't see the tx's
    // uncommitted writes/snapshot, and — worse — it holds a second pool slot for
    // the lifetime of a transaction that's already holding one. With N
    // concurrent endRide calls against a pool of size N, every connection is
    // pinned by an open transaction waiting on this second query, which itself
    // has no free connection left to run on — deadlock by connection
    // exhaustion. Callers inside a transaction MUST now pass their `tx` so this
    // reuses the same client/snapshot instead of reaching for the pool.
    //
    // Public rather than private: endRide references this through its own
    // explicit `this: {...}` structural parameter type (same optStr/
    // isUniqueViolation rule from base.ts).
    async loadRidePoints(
      rideId: number,
      executor: { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> } = db,
    ): Promise<[number, number, number][]> {
      const result = await executor.execute(
        sql`SELECT x, y, t FROM ride_points WHERE ride_id = ${rideId} ORDER BY id`,
      );
      const rows = result.rows as { x: number; y: number; t: number }[];
      return rows.map((p) => [p.x, p.y, p.t]);
    }

    // Return the ride with its live track hydrated from ride_points. Only active
    // rides read from ride_points (the authoritative live track); a finished
    // ride already has its track flushed into rides.track by endRide, so we leave
    // it untouched even though its point rows may linger.
    //
    // Public rather than private: appendRidePoint references this through its
    // own explicit `this: {...}` structural parameter type (same rule).
    async hydrateTrack(ride: Ride | undefined): Promise<Ride | undefined> {
      if (!ride) return ride;
      if (ride.status !== "active") return ride;
      const pts = await this.loadRidePoints(ride.id);
      if (pts.length === 0) return ride;
      return { ...ride, track: JSON.stringify(pts) };
    }

    async startRide(
      this: {
        invalidateBikesCache(opts?: { silent?: boolean }): void;
        isUniqueViolation(err: unknown): boolean;
        abortUnstartedRide(rideId: number, opts: { refundKopecks: number }): Promise<void>;
      },
      { bikeId, userId, tariff, prepaid }: { bikeId: string; userId: string; tariff: string; prepaid?: boolean },
    ) {
      // Hourly, prepaid model: the rider picks an hourly tariff (h1/h2/h3) and
      // pays its full price UP FRONT. The ride's cost is fixed to the tariff
      // price at start (in kopecks); endRide only adds an overage charge if the
      // rider exceeds the paid window (auto-extension). There is no per-minute
      // accrual any more.
      //
      // Two payment paths:
      //   - prepaid = true  -> the rider already paid on T-Bank's hosted/recurring
      //     flow (ride/init). The wallet must NOT be charged again here.
      //   - prepaid = false -> internal/demo flow: charge the tariff price from
      //     the wallet balance atomically as part of starting the ride.
      const tariffDef = TARIFFS.find((t) => t.id === tariff);
      const costKopecks = tariffDef ? tariffPriceKopecks(tariffDef) : 0;

      // Atomic: re-check the bike/rider state and claim the bike inside ONE
      // transaction. A bare SELECT inside a transaction does NOT lock the row
      // under Postgres' default READ COMMITTED isolation — two concurrent
      // requests could both read bike.status = 'available' before either
      // commits and both proceed to insert a ride for the same bike
      // (double-booking, audit CRITICAL #4). `.for("update")` takes a row lock
      // on SELECT, so the second transaction blocks here until the first
      // commits, then re-reads the now-current ("rented") row and correctly
      // bails out below — it never reaches the insert.
      //
      // Belt-and-suspenders: `idx_rides_active_bike` / `idx_rides_active_user`
      // (partial UNIQUE indexes, server/db/bootstrap.ts) make a second active
      // ride for the same bike or rider impossible at the database level too,
      // so a future code path that bypasses this lock still cannot double-book
      // — it gets a unique-violation instead, caught below.
      // Captured from inside the transaction so the post-commit unlock step below
      // (audit F-04) knows which physical lock to address without re-querying.
      let lockImei: string | null = null;
      const result = await (async () => {
        try {
          return await db.transaction(async (tx) => {
            const bike = (await tx.select().from(bikes).where(eq(bikes.id, bikeId)).for("update").limit(1))[0] as Bike | undefined;
            if (!bike) return { error: "Велосипед не найден" };
            lockImei = bike.lockImei ?? null;
            if (bike.status !== "available" && bike.status !== "reserved") {
              return { error: `Велосипед сейчас «${bike.status}» — недоступен для аренды` };
            }
            if (bike.battery < 18) return { error: "Низкий заряд замка, выберите другой велосипед" };
            // No row to lock here (the rider may have zero rides), so this read
            // alone cannot be made race-proof the same way — idx_rides_active_user
            // is what actually closes this half of the race; a loser lands on the
            // unique-violation catch below instead of this friendly early return.
            const active = (await tx.select().from(rides)
              .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
              .limit(1))[0] as Ride | undefined;
            if (active) return { error: "У вас уже есть активная поездка" };

            // Radius-gating (rental spec): a bike may only be started from inside
            // an active parking zone. The lock's GPS is the authoritative source
            // when we have ANY fix at all — tracking only runs during a ride, so
            // "fresh" doesn't apply here; the last fix is simply wherever the bike
            // was dropped off, and nothing moves it between rides. Only fall back
            // to the bike's stored map-space position (bikes.lat/lng) when the lock
            // has never reported a single fix yet (brand-new/never-ridden lock).
            let lockRow: Lock | undefined;
            if (bike.lockImei) {
              lockRow = (await tx.select().from(locks).where(eq(locks.imei, bike.lockImei)).limit(1))[0] as Lock | undefined;
            }
            const hasLockFix = lockRow?.lastLatitude != null && lockRow?.lastLongitude != null;
            const parkingRowsForStart = (await tx.select().from(parkings)) as Parking[];
            const startParkingMatch = hasLockFix
              ? findNearestParkingWithinRadiusFromRealCoords(lockRow!.lastLatitude!, lockRow!.lastLongitude!, parkingRowsForStart)
              : findNearestParkingWithinRadius(bike.lat, bike.lng, parkingRowsForStart);
            if (!startParkingMatch) {
              return { error: "Велосипед сейчас не в зоне парковки — начать поездку нельзя. Переместите велосипед в парковочную зону или обратитесь в поддержку." };
            }
            // Keep bikes.lat/lng (the fallback position source used when a lock has
            // no fix) in step with the lock's real GPS on every status change this
            // bike goes through, starting here.
            const syncedPos = hasLockFix ? realToMap(lockRow!.lastLatitude!, lockRow!.lastLongitude!) : null;
            const startLat = syncedPos ? syncedPos.y : bike.lat;
            const startLng = syncedPos ? syncedPos.x : bike.lng;

            // Internal (non-prepaid) flow: debit the tariff price from the wallet up
            // front, inside the same transaction so a failure rolls the ride back.
            //
            // The debit itself is a single conditional UPDATE (balance = balance -
            // cost WHERE balance >= cost), not a SELECT-then-UPDATE in app code
            // (audit CRITICAL #5). Reading `w.balance` into a JS variable and
            // writing back `w.balance - cost` is a classic lost-update race: a
            // concurrent top-up or an overage charge from another ride ending at
            // the same instant reads the same stale balance, and whichever UPDATE
            // commits last silently overwrites the other's change. A single
            // atomic SQL expression has no such window — Postgres computes
            // `balance - cost` from the current row under the row's own update,
            // so two concurrent debits/credits against the same wallet always
            // both apply, in some serial order, never one clobbering the other.
            if (!prepaid && costKopecks > 0) {
              await tx.execute(sql`
                INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at)
                VALUES (${userId}, 0, 'payg', NULL)
                ON CONFLICT (user_id) DO NOTHING
              `);
              const debited = await tx.execute(sql`
                UPDATE wallet SET balance = balance - ${costKopecks}
                WHERE user_id = ${userId} AND balance >= ${costKopecks}
                RETURNING balance
              `);
              if (debited.rows.length === 0) {
                return { error: "Недостаточно средств на балансе" };
              }
              await tx.insert(payments).values({
                userId, amount: -costKopecks, kind: "ride_charge",
                description: `Аренда ${bikeId} • ${tariffDef?.name ?? tariff}`, createdAt: Date.now(),
              });
            }

            const startedAt = Date.now();
            const track: [number, number, number][] = [[startLng, startLat, startedAt]];
            // paidUntilAt is the authoritative billing deadline going forward
            // (extended by /rides/:id/extend and by pause grace); startParkingId
            // uses the just-computed geofence match (freshest available signal)
            // rather than the bike's possibly-stale stored parkingId, for the
            // 5-minute cancel-with-refund rule (audit: must still be at the SAME parking).
            const paidUntilAt = startedAt + tariffDurationMs(tariff);
            const row = (await tx.insert(rides).values({
              bikeId, userId, startedAt,
              startLat, startLng,
              track: JSON.stringify(track), distanceM: 0, cost: costKopecks, tariff, status: "active",
              paidUntilAt, startParkingId: startParkingMatch.id,
              // Never client-supplied — derived solely from the bike row locked
              // above, so a real-customer scan of a test unit is always tagged
              // and a normal bike can never be tagged by a forged request param.
              isTest: bike.isTestBike,
            }).returning())[0] as Ride;
            await tx.update(bikes).set({
              status: "rented", updatedAt: Date.now(),
              lat: startLat, lng: startLng, parkingId: startParkingMatch.id,
            } as any).where(eq(bikes.id, bikeId));
            // Seed the append-only points table with the start point so the live
            // track (hydrated from ride_points) is never empty for a fresh ride.
            await tx.execute(sql`INSERT INTO ride_points (ride_id, x, y, t) VALUES (${row.id}, ${startLng}, ${startLat}, ${startedAt})`);
            return row;
          });
        } catch (err) {
          // idx_rides_active_bike / idx_rides_active_user (server/db/bootstrap.ts)
          // are the database-level backstop for this race; this only fires if the
          // FOR UPDATE lock above was somehow bypassed — still fail closed with a
          // friendly message instead of a raw 500.
          if (this.isUniqueViolation(err)) {
            return { error: "Не удалось начать поездку — велосипед уже забронирован или у вас уже есть активная поездка" };
          }
          throw err;
        }
      })();
      // A successful start flipped a bike to "rented" → the public list is stale.
      // Only fire side effects on the success shape (a Ride row, not an error).
      if (result && !("error" in result)) {
        this.invalidateBikesCache();
        rideEvents.emit(userId, "start" as RideEventReason);

        // Audit F-04: the DB transaction above is only half of "starting a ride" —
        // a bike fitted with a smart lock (lockImei set) must actually be physically
        // unlocked, or the rider is charged for a bike they cannot open. Dispatch
        // the unlock AFTER commit (so we never unlock a bike that failed the
        // eligibility/wallet checks), and compensate fully if the lock doesn't
        // confirm — never leave a charged rider with a bike still locked.
        //
        // Bikes with no lockImei (legacy/manual fleet, not yet fitted with a smart
        // lock) skip this entirely — there is nothing to command.
        if (lockImei) {
          let unlocked = false;
          try {
            const gateway = getLockGateway();
            if (!gateway) throw new Error("OMNI gateway is not running");
            const outcome = await gateway.sendUnlockCommand(lockImei, userId);
            unlocked = outcome.success;
          } catch (err) {
            log(`startRide: unlock failed imei=${lockImei} ride=${result.id}: ${(err as Error).message}`);
          }
          if (!unlocked) {
            await this.abortUnstartedRide(result.id, { refundKopecks: !prepaid ? costKopecks : 0 });
            return { error: "Замок не отвечает — выберите другой велосипед или попробуйте через минуту" };
          }
          // Best-effort: enable live GPS tracking (D1) for the duration of the
          // ride, superseding the temporary maybeProbeOmniDiagD1 diagnostic probe.
          // Not billing/safety-critical like the unlock above, so a failure here
          // is logged, not compensated — the ride proceeds on its normal track
          // sources (phone GPS / periodic telemetry) even without live D0 frames.
          try {
            const gateway = getLockGateway();
            const sent = gateway?.sendToDevice(lockImei, "D1", [RIDE_GPS_TRACKING_INTERVAL_SECONDS]);
            if (!sent) log(`startRide: failed to enable GPS tracking imei=${lockImei} ride=${result.id}`);
          } catch (err) {
            log(`startRide: error enabling GPS tracking imei=${lockImei} ride=${result.id}: ${(err as Error).message}`);
          }
        }
      }
      return result;
    }

    // Compensating rollback for a ride that was created (and, for the internal
    // wallet flow, already paid) but whose physical lock never confirmed the
    // unlock (audit F-04). Idempotent — a no-op if the ride is no longer active
    // (e.g. a concurrent caller already resolved it), so it is always safe to
    // call even if invoked twice.
    //
    // Only refunds the internal wallet debit: a `prepaid` (T-Bank) ride passes
    // refundKopecks = 0 here because the external charge already succeeded on
    // T-Bank's side before startRide ran — reversing that is a real Refund/Cancel
    // API call, not a local ledger credit, and today failures of that kind are
    // deliberately left for manual/support reconciliation, matching how this
    // codebase already treats other post-payment startRide failures (e.g. the
    // bike being taken in a race) in server/payments/tbank-handlers.ts.
    //
    // Public rather than private: startRide references this through its own
    // explicit `this: {...}` structural parameter type (same rule as
    // optStr/isUniqueViolation in base.ts — a private member can't satisfy a
    // plain object type from outside the declaring method's own signature).
    async abortUnstartedRide(
      this: { invalidateBikesCache(opts?: { silent?: boolean }): void },
      rideId: number,
      opts: { refundKopecks: number },
    ) {
      const outcome = await db.transaction(async (tx) => {
        const ride = (await tx.select().from(rides).where(eq(rides.id, rideId)).for("update").limit(1))[0] as Ride | undefined;
        if (!ride || ride.status !== "active") return null;
        await tx.update(rides).set({ status: "cancelled", endedAt: Date.now() } as any).where(eq(rides.id, rideId));
        await tx.update(bikes).set({ status: "available", updatedAt: Date.now() } as any).where(eq(bikes.id, ride.bikeId));
        if (opts.refundKopecks > 0) {
          await tx.execute(sql`UPDATE wallet SET balance = balance + ${opts.refundKopecks} WHERE user_id = ${ride.userId}`);
          await tx.insert(payments).values({
            userId: ride.userId, amount: opts.refundKopecks, kind: "ride_charge",
            description: `Возврат за поездку ${ride.bikeId} — замок не открылся`, createdAt: Date.now(),
          });
        }
        return ride;
      });
      if (outcome) {
        this.invalidateBikesCache();
        rideEvents.emit(outcome.userId, "end" as RideEventReason);
      }
    }

    async appendRidePoint(
      this: {
        invalidateBikesCache(opts?: { silent?: boolean }): void;
        hydrateTrack(ride: Ride | undefined): Promise<Ride | undefined>;
      },
      rideId: number,
      x: number,
      y: number,
    ) {
      // Atomic: the read-last-point → compute-distance → insert-point →
      // update-distance sequence used to run as four independent statements on
      // the default pool (audit: appendRidePoint неатомарен). A phone sending
      // points on a flaky connection retries, and two points for the same ride
      // can be in flight at once; both would read the same "last" point, each
      // compute a distance delta from it, and whichever UPDATE commits last
      // would clobber the other's distanceM instead of the two deltas
      // accumulating. `.for("update")` on the ride row serialises writers for
      // THIS ride only (other rides' points are untouched, so this isn't a
      // global bottleneck) and keeps the read+insert+update on one snapshot.
      const result = await db.transaction(async (tx) => {
        const r = (await tx.select().from(rides).where(eq(rides.id, rideId)).for("update").limit(1))[0] as Ride | undefined;
        if (!r || r.status !== "active") return undefined;
        // Distance delta is computed from the LAST stored point only — a single
        // indexed row read, not a parse of the whole track. Then we append one
        // row instead of rewriting the entire track JSON (was O(N^2) per ride).
        const last = (await tx.execute(
          sql`SELECT x, y, t FROM ride_points WHERE ride_id = ${rideId} ORDER BY id DESC LIMIT 1`,
        )).rows[0] as { x: number; y: number; t: number } | undefined;
        const px = last ? last.x : r.startLng;
        const py = last ? last.y : r.startLat;
        const dx = x - px, dy = y - py;
        const dMap = Math.sqrt(dx * dx + dy * dy);
        // 1 map unit ≈ 30 metres (≈30km coastal span across 1000 units, demo scale)
        const addedMeters = dMap * 30;
        const newDistance = r.distanceM + addedMeters;
        const now = Date.now();
        await tx.execute(sql`INSERT INTO ride_points (ride_id, x, y, t) VALUES (${rideId}, ${x}, ${y}, ${now})`);
        // Hourly prepaid model: cost is fixed at start (tariff price) and only
        // changes on overage in endRide. Live points update the distance only —
        // never the price. rides.track is finalised once in endRide.
        await tx.update(rides).set({ distanceM: newDistance }).where(eq(rides.id, rideId));
        await tx.update(bikes).set({ lat: y, lng: x, lastSeen: now, idleHours: 0 } as any)
          /* position-only во время поездки — fleet-событие не нужно (silent ниже) */
          .where(eq(bikes.id, r.bikeId));
        return r;
      });
      if (!result) return undefined;
      // Position changed → invalidate the map list and push the owning rider a
      // fresh active-ride snapshot (new track point) over SSE. silent: статус не
      // меняется, не будим fleet-стрим на каждую GPS-точку.
      this.invalidateBikesCache({ silent: true });
      rideEvents.emit(result.userId, "point" as RideEventReason);
      return this.hydrateTrack(
        (await db.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride,
      );
    }

    // ---- onboard bike tracker telemetry (independent of the rider's phone) ----
    // The OMNI smart locks are the primary writer and reach bike_telemetry through
    // the TCP ingest process (server/omni/), which batches its own INSERTs. The two
    // methods below serve the manual HTTP ingest path (/api/telemetry/bike) and the
    // ride-track read, and store positions in map space so tracker points merge
    // with the phone-fed ride track.
    async insertBikeTelemetry(
      this: { invalidateBikesCache(opts?: { silent?: boolean }): void },
      bikeId: string,
      x: number,
      y: number,
      t: number,
    ) {
      await pool.query(
        "INSERT INTO bike_telemetry (bike_id, x, y, t) VALUES ($1, $2, $3, $4)",
        [bikeId, x, y, t],
      );
      // Keep the fleet's live position fresh from the tracker too, so the ops map
      // reflects the bike even when no phone is relaying points.
      await db.update(bikes).set({ lat: y, lng: x, lastSeen: t, idleHours: 0 } as any)
        .where(eq(bikes.id, bikeId));
      this.invalidateBikesCache({ silent: true });
    }

    // Telemetry points for one bike within [fromT, toT], time-ordered. Used to
    // build the authoritative ride track for the ride's bike + time window.
    //
    // Positionless rows are skipped: a lock's battery check-in, heartbeat or
    // no-satellite-fix report is stored in the same table with NULL x/y, and must
    // not enter a track as a (null, null) point. The partial index
    // idx_bike_telemetry_pos matches this predicate.
    async getBikeTelemetry(bikeId: string, fromT: number, toT: number): Promise<[number, number, number][]> {
      const rows = (await pool.query(
        `SELECT x, y, t FROM bike_telemetry
          WHERE bike_id = $1 AND t >= $2 AND t <= $3 AND x IS NOT NULL AND y IS NOT NULL
          ORDER BY t, id`,
        [bikeId, fromT, toT],
      )).rows as { x: number; y: number; t: number }[];
      return rows.map((p) => [p.x, p.y, p.t]);
    }

    async endRide(
      this: {
        invalidateBikesCache(opts?: { silent?: boolean }): void;
        loadRidePoints(rideId: number, executor: { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }): Promise<[number, number, number][]>;
      },
      rideId: number,
      opts?: { skipGeofence?: boolean },
    ): Promise<Ride | { error: string } | undefined> {
      // Atomic: completing a ride touches four tables (ride, bike, wallet,
      // payment ledger). Doing them as separate statements risks a partial state
      // if the process dies mid-way — e.g. wallet debited but ride still active,
      // or bike freed without a charge recorded. One transaction keeps them
      // consistent: either the whole settlement lands or none of it does.
      //
      // Explicit callback return-type annotation (Radius-gating, Phase 2): without
      // it, TS's return-type inference across this callback's several `return`
      // points widens into a single "best common shape" object with every branch's
      // keys made optional, instead of a clean discriminated union — which then
      // breaks the `"error" in result` narrowing below (tsc TS2322/TS2416). An
      // explicit annotation forces the clean union we actually rely on.
      const result = await db.transaction(async (
        tx,
      ): Promise<{ error: string } | { ride: Ride; overageKopecks: number; lockImei: string | null } | undefined> => {
        // `.for("update")` locks the ride row for the duration of this tx (audit
        // HIGH: double endRide). Without it, two concurrent completions of the
        // same ride (a duplicate client request, a retried webhook) both read
        // status = 'active' before either commits, and both proceed to settle —
        // charging overage twice and running the bike-release/payment logic
        // twice. The lock serialises them: the loser blocks here until the
        // winner commits, then re-reads status = 'completed' and returns
        // undefined below, a no-op instead of a double settlement.
        const r = (await tx.select().from(rides).where(eq(rides.id, rideId)).for("update").limit(1))[0] as Ride | undefined;
        if (!r || r.status !== "active") return undefined;
        // Flush the append-only points into the canonical rides.track ONCE, at
        // completion. Fall back to the legacy in-row track for rides that started
        // before the ride_points migration and never got any point rows.
        // Pass `tx` — see the audit HIGH #15 note on loadRidePoints above.
        const pts: [number, number, number][] = await this.loadRidePoints(rideId, tx);
        const track: [number, number, number][] =
          pts.length > 0 ? pts : (JSON.parse(r.track) as [number, number, number][]);
        const last = track[track.length - 1];
        const endedAt = Date.now();
        const bike = (await tx.select().from(bikes).where(eq(bikes.id, r.bikeId)).limit(1))[0] as Bike | undefined;

        // Radius-gating (rental spec): the rider-facing end is a HARD block —
        // no fallback to the phone track's last point — unless the caller
        // explicitly opts out (staff/admin force-end, see opts.skipGeofence).
        // Rationale: the phone track is rider-controlled (mockable/spoofable via
        // dev tools) while the lock's own GPS is not, so it is the only signal
        // trusted to end a billed ride and free the bike.
        //
        // The hard block only applies when there IS a trustworthy signal to
        // enforce it with, i.e. the bike actually has a lock (bike.lockImei).
        // Legacy/manual-fleet bikes with no lock at all have no GPS source we
        // trust for gating (production currently has a single real lock —
        // most bikes are still lockless) — those keep the pre-Phase-2 behaviour
        // unchanged: settle from the phone track, parkingMatch is assignment-only
        // and never blocks the end. This is the same fallback path skipGeofence
        // uses, so both share one branch below.
        const parkingRowsForEnd = (await tx.select().from(parkings)) as Parking[];
        let finalLat: number;
        let finalLng: number;
        let parkingMatch: Parking | null;
        if (bike?.lockImei && !opts?.skipGeofence) {
          const lockRow = (await tx.select().from(locks).where(eq(locks.imei, bike.lockImei)).limit(1))[0] as Lock | undefined;
          const isFresh = lockRow?.lastLatitude != null && lockRow?.lastLongitude != null
            && lockRow?.lastLocationAt != null && (Date.now() - lockRow.lastLocationAt) <= LOCK_GPS_LIVE_MS;
          if (!isFresh) {
            return { error: "Ждём GPS-сигнал замка для подтверждения места — попробуйте завершить поездку через несколько секунд. Если сигнала долго нет, обратитесь в поддержку." };
          }
          parkingMatch = findNearestParkingWithinRadiusFromRealCoords(lockRow!.lastLatitude!, lockRow!.lastLongitude!, parkingRowsForEnd);
          if (!parkingMatch) {
            return { error: "Велосипед сейчас не в зоне парковки — завершить поездку нельзя. Переместите велосипед в парковочную зону." };
          }
          const synced = realToMap(lockRow!.lastLatitude!, lockRow!.lastLongitude!);
          finalLat = synced.y;
          finalLng = synced.x;
        } else {
          finalLat = last[1];
          finalLng = last[0];
          parkingMatch = findNearestParkingWithinRadius(finalLat, finalLng, parkingRowsForEnd);
        }

        // Hourly prepaid model. The tariff was paid at start (r.cost holds the
        // prepaid tariff price, in kopecks). If the rider kept the bike past the
        // paid window (r.paidUntilAt, which pause/extend may have moved), auto-
        // extend by charging OVERAGE_MINUTE_PRICE per started extra minute.
        // r.paidUntilAt is nullable only for rides started before this column
        // existed — fall back to the tariff's nominal duration for those.
        //
        // Pause interaction: a ride can be ended while still paused (rider taps
        // "Завершить" without resuming first). resumeRide() is the normal place
        // the free-grace credit for a pause lands on paidUntilAt, but that never
        // ran here — so the in-progress pause's free credit must be applied at
        // settlement too, or the rider silently loses grace they're entitled to.
        // Same pure helper resumeRide uses, so both agree bit for bit.
        const pauseCreditMs = pendingPauseCreditMs(
          { startedAt: r.startedAt, paidUntilAt: r.paidUntilAt, pausedAt: r.pausedAt, totalPausedMs: r.totalPausedMs },
          endedAt,
        );
        const paidUntilAt = (r.paidUntilAt ?? (r.startedAt + tariffDurationMs(r.tariff))) + pauseCreditMs;
        const paidMs = paidUntilAt - r.startedAt;
        const usedMs = endedAt - r.startedAt;
        const { extraMinutes, overageKopecks } = computeOverage(usedMs, paidMs);
        const finalCost = finalRideCost(r.cost, overageKopecks);

        await tx.update(rides).set({
          endedAt, status: "completed", cost: finalCost,
          endLat: finalLat, endLng: finalLng,
          track: JSON.stringify(track),
          // Finalise any in-progress pause into the historical record so
          // analytics see the full paused duration even though the ride ended
          // mid-pause (pausedAt itself is left as-is — harmless once completed).
          totalPausedMs: r.totalPausedMs + (r.pausedAt != null ? Math.max(0, endedAt - r.pausedAt) : 0),
        }).where(eq(rides.id, rideId));
        // Assignment is based only on live, active parkings, computed above from
        // the same validated position — merged into one update (previously two
        // separate statements) now that both share a single source of truth.
        await tx.update(bikes).set({
          status: "available", lat: finalLat, lng: finalLng,
          lastSeen: endedAt, idleHours: 0, parkingId: parkingMatch?.id ?? null,
        } as any).where(eq(bikes.id, r.bikeId));

        // Only the overage is charged at end — the base tariff was already paid at
        // start (wallet debit or T-Bank). Debit the wallet for the extra hours,
        // inside the same tx so it rolls back with everything else on failure.
        if (overageKopecks > 0) {
          // Same atomic-decrement pattern as startRide's wallet debit (audit
          // CRITICAL #5): a single UPDATE ... SET balance = balance - N,
          // never a SELECT-then-UPDATE round trip through a JS variable. The
          // rider still owes the overage even if the balance goes negative
          // (unlike startRide there is no balance check — the ride is already
          // over and must be settled), so this UPDATE is unconditional; the
          // wallet-creation UPSERT just guarantees a row exists to decrement.
          await tx.execute(sql`
            INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at)
            VALUES (${r.userId}, 0, 'payg', NULL)
            ON CONFLICT (user_id) DO NOTHING
          `);
          await tx.execute(sql`
            UPDATE wallet SET balance = balance - ${overageKopecks} WHERE user_id = ${r.userId}
          `);
          await tx.insert(payments).values({
            userId: r.userId, amount: -overageKopecks, kind: "ride_charge",
            description: `Продление аренды ${r.bikeId} • +${extraMinutes} мин`, createdAt: endedAt,
          });
        }
        return {
          ride: (await tx.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride,
          overageKopecks,
          lockImei: bike?.lockImei ?? null,
        };
      });
      if (!result) return undefined;
      if ("error" in result) return result;
      // Ended ride freed the bike (status "available") → refresh the map list and
      // push a terminal event so the rider's SSE stream sends null (ride over).
      this.invalidateBikesCache();
      rideEvents.emit(result.ride.userId, "end" as RideEventReason);
      if (result.overageKopecks > 0) {
        sendToUserAsync(result.ride.userId, {
          title: "Оплата поездки",
          body: `Списано ${formatKopecksAsRubles(result.overageKopecks)} ₽ за поездку. Спасибо, что пользуетесь TakeRide!`,
          url: "/rides",
          tag: `ride:${result.ride.id}:overage`,
          data: { kind: "ride-charge-confirmed", rideId: result.ride.id },
        });
      }
      // Best-effort: disable D1 GPS tracking now that the ride is over (saves
      // lock battery between rentals). Not billing/safety-critical, log-only.
      if (result.lockImei) {
        try {
          const gateway = getLockGateway();
          const sent = gateway?.sendToDevice(result.lockImei, "D1", [0]);
          if (!sent) log(`endRide: failed to disable GPS tracking imei=${result.lockImei} ride=${result.ride.id}`);
        } catch (err) {
          log(`endRide: error disabling GPS tracking imei=${result.lockImei} ride=${result.ride.id}: ${(err as Error).message}`);
        }
      }
      return result.ride;
    }

    // Rider tapped "Пауза". We cannot command a lock to close — only await its
    // own autonomous report (see pause-registry.ts header) — so this ARMS a
    // short-lived expectation instead of writing paused_at directly. The actual
    // paused_at write happens in server/omni/store.ts's lockReport handler once
    // the device confirms the closure. Legacy bikes with no smart lock have
    // nothing to await, so they pause immediately (mirrors startRide's
    // lockImei-gating convention elsewhere in this file).
    async requestPauseRide(rideId: number) {
      const ride = (await db.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride | undefined;
      if (!ride || ride.status !== "active") return { error: "Поездка не активна" };
      if (ride.pausedAt != null) return { error: "Поездка уже на паузе" };
      const bike = (await db.select().from(bikes).where(eq(bikes.id, ride.bikeId)).limit(1))[0] as Bike | undefined;
      if (!bike?.lockImei) {
        const updated = (await db.update(rides).set({ pausedAt: Date.now() } as any)
          .where(and(eq(rides.id, rideId), eq(rides.status, "active"), sql`${rides.pausedAt} IS NULL`))
          .returning())[0] as Ride | undefined;
        if (!updated) return { error: "Поездка не активна" };
        rideEvents.emit(updated.userId, "point" as RideEventReason);
        return { status: "paused" as const, ride: updated };
      }
      registerPendingPause(bike.lockImei, rideId, ride.userId, PAUSE_ARM_TTL_MS);
      return { status: "awaiting_lock_close" as const, expiresInMs: PAUSE_ARM_TTL_MS };
    }

    // Resume is rider-initiated and takes effect immediately — unlike pause, it
    // is never gated on a physical confirmation. Also doubles as "cancel my
    // pending pause request": if the ride is active but not yet actually
    // paused (still awaiting the lock-closure report), this just clears the
    // armed expectation and returns the ride unchanged instead of erroring.
    // Public rather than private: calls this.getBike (defined on BikeMixin)
    // through an explicit structural `this` type, same rule as
    // abortUnstartedRide/updateBike above.
    async resumeRide(this: { getBike(id: string): Promise<Bike | undefined> }, rideId: number): Promise<Ride | { error: string }> {
      const outcome = await db.transaction(async (tx) => {
        const r = (await tx.select().from(rides).where(eq(rides.id, rideId)).for("update").limit(1))[0] as Ride | undefined;
        if (!r || r.status !== "active") return { ok: false as const, error: "Поездка не активна" };
        if (r.pausedAt == null) return { ok: true as const, ride: r, cancelledPending: true };
        const now = Date.now();
        const creditMs = pendingPauseCreditMs(r, now);
        const actualPausedMs = Math.max(0, now - r.pausedAt);
        const updated = (await tx.update(rides).set({
          pausedAt: null,
          totalPausedMs: r.totalPausedMs + actualPausedMs,
          paidUntilAt: (r.paidUntilAt ?? (r.startedAt + tariffDurationMs(r.tariff))) + creditMs,
        } as any).where(eq(rides.id, rideId)).returning())[0] as Ride;
        return { ok: true as const, ride: updated, cancelledPending: false };
      });
      if (!outcome.ok) return { error: outcome.error };
      const { ride, cancelledPending } = outcome;
      // Best-effort: clear any stale armed pause expectation for this lock so a
      // late/duplicate lockReport can't re-pause a ride the rider already
      // resumed. Never blocks or fails the resume itself.
      const bike = await this.getBike(ride.bikeId).catch(() => undefined);
      if (bike?.lockImei) clearPendingPause(bike.lockImei);
      if (cancelledPending) return ride;
      rideEvents.emit(ride.userId, "point" as RideEventReason);
      // Best-effort physical re-unlock, mirroring endRide's D1-disable and
      // startRide's own unlock dispatch: never rolls the resume back on
      // failure — the billing/timer state already committed above is
      // authoritative regardless of whether the lock itself confirms.
      if (bike?.lockImei) {
        try {
          const gateway = getLockGateway();
          const sent = gateway?.sendToDevice(bike.lockImei, "D1", [RIDE_GPS_TRACKING_INTERVAL_SECONDS]);
          if (!sent) log(`resumeRide: failed to dispatch unlock imei=${bike.lockImei} ride=${rideId}`);
        } catch (err) {
          log(`resumeRide: error dispatching unlock imei=${bike.lockImei} ride=${rideId}: ${(err as Error).message}`);
        }
      }
      return ride;
    }

    // Extend the paid window by a tariff's duration, charging its price from
    // the wallet — always available, including while paused (product decision:
    // extension is independent of the pause state). Same atomic
    // conditional-UPDATE debit pattern as startRide (audit CRITICAL #5) so a
    // concurrent debit/credit against the same wallet can never be lost.
    async extendRide(rideId: number, tariff: string) {
      const tariffDef = TARIFFS.find((t) => t.id === tariff);
      if (!tariffDef) return { error: "Неизвестный тариф" };
      const costKopecks = tariffPriceKopecks(tariffDef);
      const outcome = await db.transaction(async (tx) => {
        const r = (await tx.select().from(rides).where(eq(rides.id, rideId)).for("update").limit(1))[0] as Ride | undefined;
        if (!r || r.status !== "active") return { error: "Поездка не активна" };
        const debited = await tx.execute(sql`
          UPDATE wallet SET balance = balance - ${costKopecks}
          WHERE user_id = ${r.userId} AND balance >= ${costKopecks}
          RETURNING balance
        `);
        if (debited.rows.length === 0) return { error: "Недостаточно средств на балансе" };
        await tx.insert(payments).values({
          userId: r.userId, amount: -costKopecks, kind: "ride_charge",
          description: `Продление аренды ${r.bikeId} • ${tariffDef.name}`, createdAt: Date.now(),
        });
        const basePaidUntilAt = r.paidUntilAt ?? (r.startedAt + tariffDurationMs(r.tariff));
        const updated = (await tx.update(rides).set({
          paidUntilAt: basePaidUntilAt + tariffDurationMs(tariff),
        } as any).where(eq(rides.id, rideId)).returning())[0] as Ride;
        return updated;
      });
      if (!("error" in outcome)) rideEvents.emit(outcome.userId, "point" as RideEventReason);
      return outcome;
    }

    async getRide(rideId: number) {
      return this.hydrateTrack(
        (await db.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride | undefined,
      );
    }

    async getActiveRide(userId: string) {
      return this.hydrateTrack(
        (await db.select().from(rides)
          .where(sql`${rides.userId} = ${userId} AND ${rides.status} = 'active'`)
          .limit(1))[0] as Ride | undefined,
      );
    }

    // Audit MEDIUM: hydrateTrack used to be called once per row (Promise.all
    // over N separate `ride_points` SELECTs) — one round-trip per *active*
    // ride in the page. A single active ride per rider makes the userId-scoped
    // call cheap, but the unscoped admin/global call can have as many parallel
    // queries as there are simultaneously active rides fleet-wide. Batch every
    // active ride's points into ONE `WHERE ride_id IN (...)` query and group
    // them in memory instead, mirroring listAdminRides' existing batched-IN
    // pattern for riders.
    async listRides(opts?: { userId?: string; limit?: number }) {
      const limit = opts?.limit ?? 50;
      const rows = opts?.userId
        ? ((await db.select().from(rides)
            .where(eq(rides.userId, opts.userId))
            .orderBy(desc(rides.startedAt))
            .limit(limit)) as Ride[])
        : ((await db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit)) as Ride[]);
      return this.hydrateTracks(rows);
    }

    // Batch variant of hydrateTrack: fetches ride_points for every active ride
    // in `rows` with a single query instead of one query per ride.
    private async hydrateTracks(rows: Ride[]): Promise<Ride[]> {
      const activeIds = rows.filter((r) => r.status === "active").map((r) => r.id);
      if (activeIds.length === 0) return rows;
      const pointRows = (await db.select({ rideId: ridePoints.rideId, x: ridePoints.x, y: ridePoints.y, t: ridePoints.t })
        .from(ridePoints)
        .where(inArray(ridePoints.rideId, activeIds))
        .orderBy(asc(ridePoints.rideId), asc(ridePoints.id))) as { rideId: number; x: number; y: number; t: number }[];
      const pointsByRide = new Map<number, [number, number, number][]>();
      for (const p of pointRows) {
        const arr = pointsByRide.get(p.rideId) ?? [];
        arr.push([p.x, p.y, p.t]);
        pointsByRide.set(p.rideId, arr);
      }
      return rows.map((r) => {
        const pts = pointsByRide.get(r.id);
        return pts && pts.length > 0 ? { ...r, track: JSON.stringify(pts) } : r;
      });
    }

    // Rides for the operator panel, newest first, joined to rider identity so the
    // admin table can show a name/phone instead of a raw user id. Only the riders
    // referenced by this page are fetched (single batched `IN` query) instead of
    // loading the whole users table into memory. Track points are NOT hydrated for
    // the list — the map GPS track is only needed on a single-ride view and is
    // loaded on demand via getRide (audit L5).
    async listAdminRides(opts?: { limit?: number; offset?: number }) {
      const limit = opts?.limit ?? 200;
      const offset = opts?.offset ?? 0;
      const rows = (await db.select().from(rides).orderBy(desc(rides.startedAt)).limit(limit).offset(offset)) as Ride[];
      const userIds = Array.from(new Set(rows.map((r) => r.userId)));
      const riders = userIds.length
        ? ((await db.select().from(users).where(inArray(users.id, userIds))) as User[])
        : [];
      const byId = new Map(riders.map((u) => [u.id, u]));
      return rows.map((r) => {
        const u = byId.get(r.userId);
        return { ...r, userName: u?.name ?? null, userPhone: u?.phone ?? null } as AdminRide;
      });
    }

    async countRides() {
      return (await db.select({ c: count() }).from(rides))[0].c;
    }
  };
}

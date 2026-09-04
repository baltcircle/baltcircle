import {
  bikes, unassignedLocks, locks, parkings, rides, tickets, paymentOrders,
  reservations, alerts, bikeTelemetry, rideFeedback, ridePoints, ticketComments,
} from "@shared/schema";
import type { Bike, Lock, Parking, AdminCreateBikeInput, AdminUpdateBikeInput } from "@shared/schema";
import { DEFAULT_BIKE_MODEL, bikeIdRegex, UNASSIGNED_LOCK_TTL_MS } from "@shared/schema";
import { eq, count, inArray, or } from "drizzle-orm";
import { MAP_W, MAP_H, realToMap, GPS_TRACKING_INTERVAL_SECONDS_BY_STATUS } from "@shared/geo";
import { db, pool } from "../db/bootstrap";
import { getLockGateway } from "../omni/gateway";
import type { Constructor } from "./mixin";
import type { IBikeStorage, IParkingStorage } from "./interfaces";

// Postgres unique-violation. Two operators can pick the same freshly
// discovered lock at the same time; the partial unique index on
// bikes.lock_imei is what actually decides, and the loser gets told plainly
// instead of a 500.
const LOCK_TAKEN = "Этот замок только что назначили другому велосипеду — выберите другой";

// Bike-status lifecycle: a bike must not re-enter the rental pool while its
// physical lock is still open — a rider could otherwise pick it up before the
// operator actually re-secures it. locks.last_lock_state is the only
// currently-persisted, directly-queryable signal for "is the lock physically
// closed right now" (refreshed by heartbeat, ~4 min cadence, and forced to
// "locked" on lock-close events) — it can lag reality by a few minutes but is
// the best available signal without new protocol plumbing. Fail-closed: a
// lock with no reported state yet (brand-new/never connected) or a missing
// registry row is treated the same as "open", not "unknown-so-allow".
export const LOCK_OPEN_BLOCKS_AVAILABLE = "Нельзя перевести велосипед в статус «Доступен» — замок открыт";

export async function assertLockClosedForAvailable(
  lockImei: string | null | undefined,
): Promise<string | null> {
  if (!lockImei) return null; // no lock attached — nothing to verify
  const lockRow = (await db.select().from(locks).where(eq(locks.imei, lockImei)).limit(1))[0] as Lock | undefined;
  if (lockRow?.lastLockState !== "locked") return LOCK_OPEN_BLOCKS_AVAILABLE;
  return null;
}

// Audit (scalability): bike_telemetry is unbounded heartbeat/GPS check-in
// noise from every lock (Q0/H0/D0/S5/W0 reports), unrelated to ride_points
// (permanent per-ride track history, never purged). 30 days covers the
// realistic window for investigating a lock/dispute complaint about a past
// date while keeping the table from growing forever as the fleet and ping
// rate grow. See purgeOldTelemetry, called on a timer from server/index.ts.
export const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Radius-gating (rental spec, Phase 2): bikes.lat/lng is the position-of-
// record whenever a lock has no live GPS fix yet — it's the fallback source
// startRide/endRide use for the geofence check. Keep it in step with the
// lock's own real GPS on every STATUS transition, not just during rides, so
// a bike sitting in maintenance/storage for days doesn't resurface with a
// stale stored position the moment it's set back to "available". Best-effort
// only: no lock, or a lock with no fix yet (brand-new/never-connected) ->
// null, and the caller keeps whatever position the bike already had.
async function resolveLockPositionForBikeStatusChange(
  lockImei: string | null | undefined,
): Promise<{ lat: number; lng: number } | null> {
  if (!lockImei) return null;
  const lockRow = (await db.select().from(locks).where(eq(locks.imei, lockImei)).limit(1))[0] as Lock | undefined;
  if (lockRow?.lastLatitude == null || lockRow?.lastLongitude == null) return null;
  const { x, y } = realToMap(lockRow.lastLatitude, lockRow.lastLongitude);
  return { lat: y, lng: x };
}

export function BikeMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IBikeStorage {
    async listBikes(this: { bikesCacheTtlMs: number; _bikesCache: Bike[] | null; _bikesCacheAt: number }, opts?: { includeArchived?: boolean }) {
      const now = Date.now();
      let rows = this._bikesCache;
      if (!rows || now - this._bikesCacheAt >= this.bikesCacheTtlMs) {
        rows = (await db.select().from(bikes)) as Bike[];
        this._bikesCache = rows;
        this._bikesCacheAt = now;
      }
      if (opts?.includeArchived) return rows;
      return rows.filter((b) => b.status !== "archived");
    }

    async getBike(id: string) { return (await db.select().from(bikes).where(eq(bikes.id, id)).limit(1))[0] as Bike | undefined; }

    async updateBike(
      this: { invalidateBikesCache(opts?: { silent?: boolean }): void; getBike(id: string): Promise<Bike | undefined> },
      id: string,
      patch: Partial<Bike>,
    ) {
      // Position-sync: only when the caller is changing status and did NOT
      // already specify a position itself (e.g. live telemetry ingestion sets
      // lat/lng directly and must not be overridden by a stale lock reading).
      let set: Partial<Bike> = patch;
      if (patch.status !== undefined && patch.lat === undefined && patch.lng === undefined) {
        const existing = await this.getBike(id);
        const pos = await resolveLockPositionForBikeStatusChange(existing?.lockImei);
        if (pos) set = { ...patch, lat: pos.lat, lng: pos.lng };
      }
      await db.update(bikes).set(set as any).where(eq(bikes.id, id));
      this.invalidateBikesCache();
      return this.getBike(id);
    }

    // ---------- Bikes: admin CRUD (staff only) ----------
    // Any registry lock not fitted to a bike is eligible for binding, regardless
    // of connectivity. The TCP gateway creates a registry row directly, so the
    // legacy unassigned_locks discovery buffer cannot be the source of this list.
    // Keep the anti-join while legacy bike.lock_imei bindings exist: it prevents a
    // pre-registry bike binding from being offered again before its registry row is
    // next synchronized.
    async listUnassignedLocks(): Promise<{ imei: string; lastSeen: number | null }[]> {
      return (await pool.query(
        `SELECT l.imei, l.last_seen_at AS "lastSeen" FROM locks l
          WHERE l.bike_id IS NULL
            AND l.status <> 'decommissioned'
            AND NOT EXISTS (SELECT 1 FROM bikes b WHERE b.lock_imei = l.imei)
          ORDER BY l.last_seen_at DESC NULLS LAST, l.created_at DESC`,
      )).rows as { imei: string; lastSeen: number | null }[];
    }

    // A lock that has dialled into the OMNI gateway at least once but has no
    // `locks` registry row yet (resolveAuth's fail-closed rejection records the
    // sighting via recordUnassignedLock — see server/omni/server.ts). This is
    // how an operator learns a brand-new lock's IMEI without reading it off the
    // device, so they can register it (POST /api/admin/locks) right after
    // powering it on / inserting its SIM. Excludes IMEIs that already got a
    // registry row through some other path (e.g. manual entry while this row
    // was still buffered) and anything older than the discovery TTL, in case
    // the write-side prune hasn't run yet.
    async listDiscoveredLocks(): Promise<{ imei: string; firstSeen: number; lastSeen: number }[]> {
      return (await pool.query(
        `SELECT u.imei, u.first_seen AS "firstSeen", u.last_seen AS "lastSeen"
           FROM unassigned_locks u
          WHERE u.last_seen >= $1
            AND NOT EXISTS (SELECT 1 FROM locks l WHERE l.imei = u.imei)
          ORDER BY u.last_seen DESC`,
        [Date.now() - UNASSIGNED_LOCK_TTL_MS],
      )).rows as { imei: string; firstSeen: number; lastSeen: number }[];
    }

    // The lock is now in the registry, so its discovery row is noise. Best-effort:
    // listUnassignedLocks already excludes assigned IMEIs, so failing to clean up
    // is cosmetic and must not fail the bike that was successfully created.
    //
    // Public rather than private: createBike/adminUpdateBike reference this
    // cross-method through an explicit `this:` structural parameter type (see
    // server/storage/base.ts's optStr/isUniqueViolation comment for why a
    // private member can't satisfy that kind of check once called externally
    // as storage.createBike(...)).
    async forgetUnassignedLock(imei: string): Promise<void> {
      try {
        await db.delete(unassignedLocks).where(eq(unassignedLocks.imei, imei));
      } catch {
        /* ignore */
      }
    }

    // Keep the registry's explicit bike_id relationship in step with the legacy
    // bikes.lock_imei binding. Rows may be absent for old/manual bindings, so an
    // UPDATE affecting zero rows is intentional and must not reject the bike save.
    async syncLockRegistryBinding(imei: string, bikeId: string | null): Promise<void> {
      await db.update(locks).set({ bikeId, updatedAt: Date.now() } as any).where(eq(locks.imei, imei));
    }

    // Create a real (non-demo) bike. The id is unique (primary key); a duplicate
    // is rejected with a clear message. Map coordinates default to the assigned
    // parking station or the map centre so the bike has a valid position.
    async createBike(
      this: {
        getBike(id: string): Promise<Bike | undefined>;
        optStr(v: string | undefined): string | null;
        isUniqueViolation(err: unknown): boolean;
        invalidateBikesCache(opts?: { silent?: boolean }): void;
        syncLockRegistryBinding(imei: string, bikeId: string | null): Promise<void>;
        forgetUnassignedLock(imei: string): Promise<void>;
      },
      input: AdminCreateBikeInput,
    ) {
      const id = input.id.trim().toUpperCase();
      if (await this.getBike(id)) return { error: "Велосипед с таким кодом уже существует" };

      let lat = MAP_H / 2;
      let lng = MAP_W / 2;
      const parkingId = this.optStr(input.parkingId);
      if (parkingId) {
        const p = (await db.select().from(parkings).where(eq(parkings.id, parkingId)).limit(1))[0] as Parking | undefined;
        if (p) { lat = p.lat; lng = p.lng; }
      }

      const now = Date.now();
      const lockImei = input.lockImei.trim();
      try {
        await db.insert(bikes).values({
          id,
          model: DEFAULT_BIKE_MODEL,
          status: input.status,
          battery: input.battery,
          lat, lng,
          lastSeen: now,
          idleHours: 0,
          flagged: false,
          lockImei,
          parkingId,
          notes: this.optStr(input.notes),
          seed: false,
        } as any);
      } catch (err) {
        if (this.isUniqueViolation(err)) return { error: LOCK_TAKEN };
        throw err;
      }
      await this.syncLockRegistryBinding(lockImei, id);
      await this.forgetUnassignedLock(lockImei);
      this.invalidateBikesCache();
      // GPS-interval sync (fire-and-forget, mirrors adminUpdateBike's PATCH
      // path): a freshly created bike must start tracking immediately, at
      // whatever cadence its initial status implies — otherwise the lock
      // only ever sends heartbeat/checkin (battery, lock state) and never a
      // position report, since D1 is what turns GPS reporting on at all.
      getLockGateway()?.syncGpsTrackingForStatus(lockImei, id, input.status);
      // No lock has ever reported a fix as this bike yet, so lat/lng is still
      // the map-center/parking-picker placeholder set above, not a real
      // position. Arm a one-shot recompute for whenever the first real fix
      // lands (same mechanism adminUpdateBike uses when a PATCH transitions
      // a bike into "available") so parkingId self-corrects instead of
      // staying whatever the operator picked (or left empty) at creation.
      if (input.status === "available") {
        getLockGateway()?.armParkingRecalc(lockImei, id);
      }
      return { bike: (await this.getBike(id))! };
    }

    async adminUpdateBike(
      this: IBikeStorage & IParkingStorage & {
        optStr(v: string | undefined): string | null;
        isUniqueViolation(err: unknown): boolean;
        invalidateBikesCache(opts?: { silent?: boolean }): void;
        syncLockRegistryBinding(imei: string, bikeId: string | null): Promise<void>;
        forgetUnassignedLock(imei: string): Promise<void>;
        recalculateBikeParking(bike: Pick<Bike, "id" | "lat" | "lng">): Promise<void>;
      },
      id: string,
      patch: AdminUpdateBikeInput,
    ) {
      const existing = await this.getBike(id);
      if (!existing) return { error: "Велосипед не найден" };

      // Block entering "available" while the lock is open. Checked against the
      // PATCH's own lockImei when a lock swap is part of the same request — a
      // brand-new lock has never reported a state yet, so it fails closed too.
      if (patch.status === "available") {
        const effectiveLockImei = patch.lockImei !== undefined ? patch.lockImei.trim() : existing.lockImei;
        const lockError = await assertLockClosedForAvailable(effectiveLockImei);
        if (lockError) return { error: lockError };
      }

      // Rename: bikes.id is referenced by FK (ON UPDATE CASCADE) from
      // reservations/alerts/locks/rides/tickets/paymentOrders, so a single
      // UPDATE on the parent row propagates everywhere automatically. The
      // one exception is bike_telemetry (deliberately no FK — high-volume
      // raw-SQL table), which we cascade by hand in the same transaction.
      // Blocked mid-ride: a live ride's in-memory OMNI/live-track state is
      // keyed by the pre-rename id and must not be swapped out from under it.
      let workingId = id;
      if (patch.id !== undefined) {
        const newId = patch.id.trim().toUpperCase();
        if (newId !== existing.id) {
          if (!bikeIdRegex.test(newId)) {
            return { error: "Код: латиница, цифры и дефис (2–20 символов)" };
          }
          if (existing.status === "rented") {
            return { error: "Нельзя изменить код велосипеда во время активной аренды" };
          }
          if (await this.getBike(newId)) {
            return { error: "Велосипед с таким кодом уже существует" };
          }
          try {
            await db.transaction(async (tx) => {
              await tx.update(bikes).set({ id: newId } as any).where(eq(bikes.id, existing.id));
              await tx.update(bikeTelemetry).set({ bikeId: newId }).where(eq(bikeTelemetry.bikeId, existing.id));
            });
          } catch (err) {
            if (this.isUniqueViolation(err)) return { error: "Велосипед с таким кодом уже существует" };
            throw err;
          }
          workingId = newId;
          this.invalidateBikesCache();
        }
      }

      const set: Partial<Bike> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.battery !== undefined) set.battery = patch.battery;
      // Radius-gating (Phase 2): AdminUpdateBikeInput carries no lat/lng field
      // at all, so any status transition is free to sync from the lock's own
      // GPS. Resolved against the PRE-swap lockImei — a lock swap in this same
      // PATCH (see swappingLock below) has never reported a fix as this bike
      // yet, so there is nothing trustworthy to sync from until it connects.
      let syncedPos: { lat: number; lng: number } | null = null;
      if (patch.status !== undefined) {
        syncedPos = await resolveLockPositionForBikeStatusChange(existing.lockImei);
        if (syncedPos) { set.lat = syncedPos.lat; set.lng = syncedPos.lng; }
      }
      if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);
      if (patch.parkingId !== undefined) {
        const parkingId = this.optStr(patch.parkingId);
        set.parkingId = parkingId;
      }
      // Swapping the lock resets its live state: the new lock has not connected
      // as this bike yet, and inheriting the old one's "online" would show a dead
      // bike as reachable until the ingest corrects it.
      const swappingLock = patch.lockImei !== undefined && patch.lockImei !== existing.lockImei;
      if (swappingLock) {
        set.lockImei = patch.lockImei!.trim();
        set.lockOnline = false;
        set.lockLastSeen = null;
      }
      try {
        await db.update(bikes).set(set as any).where(eq(bikes.id, workingId));
      } catch (err) {
        if (this.isUniqueViolation(err)) return { error: LOCK_TAKEN };
        throw err;
      }
      // A manual transition into the rental pool uses the lock's current position,
      // not the operator-selected parking. This deliberately overwrites any
      // parkingId supplied in the same PATCH; the regular parking picker remains
      // available for overrides when the bike is not transitioning to available.
      // Feed the JUST-SYNCED position (if any), not the stale pre-PATCH
      // `existing` — otherwise a bike that just got a fresh lock fix would be
      // re-parked against where it was sitting before this update instead of
      // where it actually is now.
      if (patch.status === "available" && existing.status !== "available") {
        await this.recalculateBikeParking(syncedPos ? { ...existing, ...syncedPos } : existing);
        // The parkingId above is only as fresh as resolveLockPositionForBikeStatusChange's
        // snapshot of locks.last_latitude/lng (bike-status lifecycle spec, 2026-09) —
        // for a bike coming out of a slower-cadence status than "available" itself
        // (maintenance/offline/storage/archived, currently 3600s) that snapshot can be
        // up to an hour stale. bikes.lat/lng self-corrects on the very next ordinary
        // telemetry report (applyLiveUpdates in server/omni/store.ts), but nothing
        // re-derives parkingId from it — arm a one-shot recompute for whenever that
        // report actually lands, at whatever cadence syncGpsTrackingForStatus just set.
        if (existing.lockImei
          && GPS_TRACKING_INTERVAL_SECONDS_BY_STATUS[existing.status as keyof typeof GPS_TRACKING_INTERVAL_SECONDS_BY_STATUS]
            > GPS_TRACKING_INTERVAL_SECONDS_BY_STATUS.available) {
          getLockGateway()?.armParkingRecalc(existing.lockImei, workingId);
        }
      } else if (patch.status !== undefined && patch.parkingId === undefined) {
        // Any other status change (maintenance/offline/storage/etc, or
        // resubmitting the same status) with no explicit operator-chosen
        // parkingId in this PATCH: re-derive parkingId from the just-synced
        // GPS position so parking occupancy (listParkings()) doesn't go
        // stale when a bike is physically moved during service. An explicit
        // patch.parkingId is still a full manual override here, unlike the
        // into-available transition above which always wins over it.
        await this.recalculateBikeParking(syncedPos ? { ...existing, ...syncedPos } : existing);
      }
      if (swappingLock) {
        if (existing.lockImei) await this.syncLockRegistryBinding(existing.lockImei, null);
        await this.syncLockRegistryBinding(set.lockImei!, workingId);
        await this.forgetUnassignedLock(set.lockImei!);
      }
      this.invalidateBikesCache();
      return { bike: (await this.getBike(workingId))! };
    }

    // Soft delete: mark a bike archived so it drops out of the public list and
    // rental selection while keeping its ride history intact.
    async archiveBike(
      this: {
        getBike(id: string): Promise<Bike | undefined>;
        invalidateBikesCache(opts?: { silent?: boolean }): void;
      },
      id: string,
    ) {
      const existing = await this.getBike(id);
      if (!existing) return { error: "Велосипед не найден" };
      if (existing.status === "rented") return { error: "Нельзя архивировать велосипед во время активной аренды" };
      await db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id));
      this.invalidateBikesCache();
      return { bike: (await this.getBike(id))! };
    }

    // Undo archiveBike. Restores straight to "offline" rather than
    // "available": a bike may have sat archived for a long time (dead lock
    // battery, moved/lost location, needs a physical check), so it must not
    // re-enter the public rentable pool unattended — mirrors how a bike
    // freshly registered or coming out of "maintenance"/"storage" always
    // needs an explicit operator step (edit form) to flip it to "available".
    async restoreBike(
      this: {
        getBike(id: string): Promise<Bike | undefined>;
        invalidateBikesCache(opts?: { silent?: boolean }): void;
      },
      id: string,
    ) {
      const existing = await this.getBike(id);
      if (!existing) return { error: "Велосипед не найден" };
      if (existing.status !== "archived") return { error: "Велосипед не в архиве" };
      await db.update(bikes).set({ status: "offline" } as any).where(eq(bikes.id, id));
      this.invalidateBikesCache();
      return { bike: (await this.getBike(id))! };
    }

    // Hard delete: only allowed when the bike has no ride/ticket/payment-order
    // history. Otherwise we refuse and archive instead, so analytics records
    // never dangle. Audit "missing FK constraints" fix: rides.bike_id,
    // tickets.bike_id and payment_orders.bike_id now carry a real (NOT VALID)
    // FOREIGN KEY to bikes.id — a hard delete while any of them still points at
    // this bike would fail with an unhandled 23503 instead of this friendly
    // archive fallback, so all three referencing tables must be checked here,
    // not just rides as before.
    async deleteBike(
      this: {
        getBike(id: string): Promise<Bike | undefined>;
        invalidateBikesCache(opts?: { silent?: boolean }): void;
      },
      id: string,
    ) {
      const existing = await this.getBike(id);
      if (!existing) return { error: "Велосипед не найден" };
      if (existing.status === "rented") return { error: "Нельзя удалить велосипед во время активной аренды" };
      const [rideCount, ticketCount, orderCount] = await Promise.all([
        db.select({ c: count() }).from(rides).where(eq(rides.bikeId, id)),
        db.select({ c: count() }).from(tickets).where(eq(tickets.bikeId, id)),
        db.select({ c: count() }).from(paymentOrders).where(eq(paymentOrders.bikeId, id)),
      ]).then((rs) => rs.map((r) => r[0].c));
      if (rideCount > 0 || ticketCount > 0 || orderCount > 0) {
        await db.update(bikes).set({ status: "archived" } as any).where(eq(bikes.id, id));
        this.invalidateBikesCache();
        return { error: "У велосипеда есть история поездок/заявок — он переведён в архив", archived: (await this.getBike(id))! };
      }
      await db.delete(bikes).where(eq(bikes.id, id));
      this.invalidateBikesCache();
      return { ok: true as const };
    }

    // Permanent purge for a decommissioned DEMO unit, including its ride/
    // ticket/payment-order/reservation/alert/telemetry history. Deliberately
    // NOT a general-purpose hard delete: restricted to seed===true AND
    // already archived. The per-bike isTestBike flag this used to also honour
    // has been removed (no more designated test units on the real fleet), so
    // demo/seed rows from the reseed migration are now the only ones ever
    // eligible — a real fleet bike can never reach this path.
    async purgeArchivedTestBike(
      this: {
        getBike(id: string): Promise<Bike | undefined>;
        invalidateBikesCache(opts?: { silent?: boolean }): void;
      },
      id: string,
    ): Promise<
      | { ok: true; deleted: Record<
          "rides" | "tickets" | "paymentOrders" | "reservations" | "alerts" | "ticketComments" | "rideFeedback" | "ridePoints" | "telemetry",
          number
        > }
      | { error: string }
    > {
      const existing = await this.getBike(id);
      if (!existing) return { error: "Велосипед не найден" };
      // The isTestBike operator flag is gone (no more per-bike test units), so
      // a demo/seed row from the reseed migration is now the only thing that
      // can ever reach this path.
      if (!existing.seed) {
        return { error: "Безвозвратно удалить можно только демо-сидированный велосипед" };
      }
      if (existing.status !== "archived") return { error: "Сначала переведите велосипед в архив" };

      return db.transaction(async (tx) => {
        const rideRows = await tx.select({ id: rides.id }).from(rides).where(eq(rides.bikeId, id));
        const rideIds = rideRows.map((r) => r.id);
        const ticketRows = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.bikeId, id));
        const ticketIds = ticketRows.map((r) => r.id);

        const rideFeedbackDeleted = rideIds.length
          ? (await tx.delete(rideFeedback).where(inArray(rideFeedback.rideId, rideIds))).rowCount ?? 0
          : 0;
        const ridePointsDeleted = rideIds.length
          ? (await tx.delete(ridePoints).where(inArray(ridePoints.rideId, rideIds))).rowCount ?? 0
          : 0;
        const ticketCommentsDeleted = ticketIds.length
          ? (await tx.delete(ticketComments).where(inArray(ticketComments.ticketId, ticketIds))).rowCount ?? 0
          : 0;

        const paymentOrdersDeleted = (await tx.delete(paymentOrders).where(eq(paymentOrders.bikeId, id))).rowCount ?? 0;
        const ticketsDeleted = (await tx.delete(tickets).where(eq(tickets.bikeId, id))).rowCount ?? 0;
        const reservationsDeleted = rideIds.length
          ? (await tx.delete(reservations).where(or(eq(reservations.bikeId, id), inArray(reservations.claimedRideId, rideIds)))).rowCount ?? 0
          : (await tx.delete(reservations).where(eq(reservations.bikeId, id))).rowCount ?? 0;
        const alertsDeleted = (await tx.delete(alerts).where(eq(alerts.bikeId, id))).rowCount ?? 0;
        const telemetryDeleted = (await tx.delete(bikeTelemetry).where(eq(bikeTelemetry.bikeId, id))).rowCount ?? 0;
        const ridesDeleted = (await tx.delete(rides).where(eq(rides.bikeId, id))).rowCount ?? 0;

        // Keep the lock registry in step — the row survives (ON DELETE SET
        // NULL), but the legacy binding lived on the bike we're about to drop.
        if (existing.lockImei) {
          await tx.update(locks).set({ bikeId: null, updatedAt: Date.now() } as any).where(eq(locks.imei, existing.lockImei));
        }

        await tx.delete(bikes).where(eq(bikes.id, id));
        this.invalidateBikesCache();
        return {
          ok: true as const,
          deleted: {
            rides: ridesDeleted, tickets: ticketsDeleted, paymentOrders: paymentOrdersDeleted,
            reservations: reservationsDeleted, alerts: alertsDeleted, ticketComments: ticketCommentsDeleted,
            rideFeedback: rideFeedbackDeleted, ridePoints: ridePointsDeleted, telemetry: telemetryDeleted,
          },
        };
      });
    }

    // Audit (scalability): see TELEMETRY_RETENTION_MS above. Deletes in
    // batches (default 2000 rows x up to 25 batches = 50k/call) rather than
    // one unbounded statement — a first-run backlog on a fleet that's been
    // live for months must not hold a single long DELETE against a table
    // every OMNI ingest write also touches. Called hourly from
    // server/index.ts; a backlog larger than one call's cap just gets
    // finished on the next tick.
    async purgeOldTelemetry(opts?: { maxBatches?: number; batchSize?: number }): Promise<number> {
      const batchSize = opts?.batchSize ?? 2000;
      const maxBatches = opts?.maxBatches ?? 25;
      const cutoff = Date.now() - TELEMETRY_RETENTION_MS;
      let totalDeleted = 0;
      for (let i = 0; i < maxBatches; i++) {
        const result = await pool.query(
          `DELETE FROM bike_telemetry WHERE id IN (
             SELECT id FROM bike_telemetry WHERE t < $1 ORDER BY id LIMIT $2
           )`,
          [cutoff, batchSize],
        );
        const deleted = result.rowCount ?? 0;
        totalDeleted += deleted;
        if (deleted < batchSize) break; // caught up — nothing older left
      }
      return totalDeleted;
    }
  };
}

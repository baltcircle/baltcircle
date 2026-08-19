import { bikes, unassignedLocks, locks, parkings, rides, tickets, paymentOrders } from "@shared/schema";
import type { Bike, Parking, AdminCreateBikeInput, AdminUpdateBikeInput } from "@shared/schema";
import { eq, count } from "drizzle-orm";
import { MAP_W, MAP_H } from "@shared/geo";
import { db, pool } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IBikeStorage, IParkingStorage } from "./interfaces";

// Postgres unique-violation. Two operators can pick the same freshly
// discovered lock at the same time; the partial unique index on
// bikes.lock_imei is what actually decides, and the loser gets told plainly
// instead of a 500.
const LOCK_TAKEN = "Этот замок только что назначили другому велосипеду — выберите другой";

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
      await db.update(bikes).set(patch as any).where(eq(bikes.id, id));
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
          model: input.model.trim(),
          status: input.status,
          battery: input.battery,
          lat, lng,
          lastSeen: now,
          idleHours: 0,
          flagged: false,
          serial: this.optStr(input.serial),
          lockId: this.optStr(input.lockId),
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

      const set: Partial<Bike> = {};
      if (patch.model !== undefined) set.model = patch.model.trim();
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.battery !== undefined) set.battery = patch.battery;
      if (patch.serial !== undefined) set.serial = this.optStr(patch.serial);
      if (patch.lockId !== undefined) set.lockId = this.optStr(patch.lockId);
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
        await db.update(bikes).set(set as any).where(eq(bikes.id, id));
      } catch (err) {
        if (this.isUniqueViolation(err)) return { error: LOCK_TAKEN };
        throw err;
      }
      // A manual transition into the rental pool uses the lock's current position,
      // not the operator-selected parking. This deliberately overwrites any
      // parkingId supplied in the same PATCH; the regular parking picker remains
      // available for overrides when the bike is not transitioning to available.
      if (patch.status === "available" && existing.status !== "available") {
        await this.recalculateBikeParking(existing);
      }
      if (swappingLock) {
        if (existing.lockImei) await this.syncLockRegistryBinding(existing.lockImei, null);
        await this.syncLockRegistryBinding(set.lockImei!, id);
        await this.forgetUnassignedLock(set.lockImei!);
      }
      this.invalidateBikesCache();
      return { bike: (await this.getBike(id))! };
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
  };
}

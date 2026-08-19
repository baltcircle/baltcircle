import {
  bikes, locks, unassignedLocks, parkings, zones, rides, tickets, paymentOrders, wallet, payments, ridePoints, users,
} from "@shared/schema";
import type {
  Bike, Parking, ZoneRow, Ride, AdminRide, User,
  AdminCreateBikeInput, AdminUpdateBikeInput, AdminCreateParkingInput, AdminUpdateParkingInput,
  Lock, AdminCreateLockInput, AdminUpdateLockInput,
} from "@shared/schema";
import { eq, desc, sql, and, asc, inArray, count } from "drizzle-orm";
import {
  MAP_W, MAP_H, TARIFFS, tariffPriceKopecks, findNearestParkingWithinRadius,
} from "@shared/geo";
import { computeOverage, finalRideCost, formatKopecksAsRubles } from "@shared/billing";
import { sendToUserAsync } from "./push";
import { getLockGateway } from "./omni/gateway";
import { log } from "./logger";
// db client + schema bootstrap + migrations + demo seed run on import of this module.
// bootstrapReady MUST be awaited before serving requests (server entrypoint does this).
import { db, pool, bootstrapReady } from "./db/bootstrap";
export { db, pool, bootstrapReady };

// Re-exported for external callers (SSE fan-out, admin bike-list broadcast).
export { bikeEvents, BIKE_EVENT_CHANNEL } from "./storage/events";
import { rideEvents } from "./storage/events";
export { rideEvents };
import type { RideEventReason } from "./storage/events";
export type { RideEventReason };

// Re-exported: phone normalization / admin-role resolution used outside storage.ts.
export { normalizePhone, isAdminPhone, resolveRole } from "./storage/base";

import { compose } from "./storage/mixin";
import { BaseStorage } from "./storage/base";
import { UserMixin } from "./storage/user";
import { OtpMixin } from "./storage/otp";
import { PaymentMethodMixin } from "./storage/payment-method";
import { SupportMixin } from "./storage/support";
import { WalletMixin } from "./storage/wallet";
import { TicketMixin } from "./storage/ticket";
import { MapObjectMixin } from "./storage/map-object";
import { AnalyticsMixin } from "./storage/analytics";

// IStorage is split into domain-segmented sub-interfaces; re-exported for callers.
import type { IStorage } from "./storage/interfaces";
export type { IStorage };

// Composition root: DatabaseStorage assembles every domain mixin (Stage 1 of
// the god-class refactor) on top of BaseStorage's shared cache/helpers. Bike,
// Lock, Parking and Ride domains are not yet extracted into their own mixin
// files (planned for Stage 2/3) and stay verbatim below, unmoved, so this
// PR only changes *where* code lives for the migrated domains, not what it
// does. The class must remain zero-arg-constructible: server/storage.account-delete.test.ts
// does `new DatabaseStorage().deleteAccount(...)` directly.
export class DatabaseStorage
  extends compose(BaseStorage)
    .with(UserMixin)
    .with(OtpMixin)
    .with(PaymentMethodMixin)
    .with(SupportMixin)
    .with(WalletMixin)
    .with(TicketMixin)
    .with(MapObjectMixin)
    .with(AnalyticsMixin)
    .build()
  implements IStorage
{
  async listBikes(opts?: { includeArchived?: boolean }) {
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
  async updateBike(id: string, patch: Partial<Bike>) {
    await db.update(bikes).set(patch as any).where(eq(bikes.id, id));
    this.invalidateBikesCache();
    return this.getBike(id);
  }

  // ---------- Bikes: admin CRUD (staff only) ----------
  // Normalize an optional string field: trim, and treat "" as null so blank
  // form inputs clear the column rather than storing an empty string.
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

  // ---------- Lock device registry: admin CRUD ----------
  async listLocks(): Promise<Lock[]> {
    return await db.select().from(locks).orderBy(desc(locks.createdAt)) as Lock[];
  }

  async createLock(input: AdminCreateLockInput): Promise<{ lock: Lock } | { error: string }> {
    const bikeId = this.optStr(input.bikeId);
    if (bikeId && !await this.getBike(bikeId)) return { error: "Велосипед не найден" };

    const now = Date.now();
    try {
      const inserted = await db.insert(locks).values({
        imei: input.imei.trim(),
        macAddress: this.optStr(input.macAddress),
        bikeId,
        simIccid: this.optStr(input.simIccid),
        firmwareVersion: this.optStr(input.firmwareVersion),
        apn: this.optStr(input.apn) ?? "cmiot",
        status: input.status ?? "unregistered",
        notes: this.optStr(input.notes),
        createdAt: now,
        updatedAt: now,
      }).returning();
      return { lock: inserted[0] as Lock };
    } catch (err) {
      if (this.isUniqueViolation(err)) return { error: "Замок с таким IMEI уже зарегистрирован" };
      throw err;
    }
  }

  async getLock(id: number): Promise<Lock | undefined> {
    return (await db.select().from(locks).where(eq(locks.id, id)).limit(1))[0] as Lock | undefined;
  }

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

  async updateLock(id: number, patch: AdminUpdateLockInput): Promise<{ lock: Lock } | { error: string }> {
    const existing = (await db.select().from(locks).where(eq(locks.id, id)).limit(1))[0] as Lock | undefined;
    if (!existing) return { error: "Замок не найден" };

    const set: Partial<Lock> = { updatedAt: Date.now() };
    if (patch.bikeId !== undefined) {
      const bikeId = this.optStr(patch.bikeId);
      if (bikeId && !await this.getBike(bikeId)) return { error: "Велосипед не найден" };
      set.bikeId = bikeId;
    }
    if (patch.macAddress !== undefined) set.macAddress = this.optStr(patch.macAddress);
    if (patch.simIccid !== undefined) set.simIccid = this.optStr(patch.simIccid);
    if (patch.firmwareVersion !== undefined) set.firmwareVersion = this.optStr(patch.firmwareVersion);
    if (patch.apn !== undefined) set.apn = this.optStr(patch.apn) ?? "cmiot";
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);

    const updated = await db.update(locks).set(set as any).where(eq(locks.id, id)).returning();
    return { lock: updated[0] as Lock };
  }

  // Device history is retained. DELETE is intentionally a lifecycle transition,
  // not a physical row deletion.
  async decommissionLock(id: number): Promise<{ lock: Lock } | { error: string }> {
    const updated = await db.update(locks).set({
      status: "decommissioned",
      updatedAt: Date.now(),
    }).where(eq(locks.id, id)).returning();
    if (!updated[0]) return { error: "Замок не найден" };
    return { lock: updated[0] as Lock };
  }

  // Postgres unique-violation. Two operators can pick the same freshly
  // discovered lock at the same time; the partial unique index on
  // bikes.lock_imei is what actually decides, and the loser gets told plainly
  // instead of a 500.
  // Drizzle wraps driver errors in a DrizzleQueryError whose own `code` is
  // undefined and keeps the pg error (carrying the SQLSTATE) on `cause`, while
  // a raw pool.query throws that pg error directly. Both shapes reach here, so
  // both are checked — matching only the top level lets a duplicate IMEI
  // written through Drizzle escape as a 500.
  private static readonly LOCK_TAKEN =
    "Этот замок только что назначили другому велосипеду — выберите другой";

  // Create a real (non-demo) bike. The id is unique (primary key); a duplicate
  // is rejected with a clear message. Map coordinates default to the assigned
  // parking station or the map centre so the bike has a valid position.
  async createBike(input: AdminCreateBikeInput) {
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
      if (this.isUniqueViolation(err)) return { error: DatabaseStorage.LOCK_TAKEN };
      throw err;
    }
    await this.syncLockRegistryBinding(lockImei, id);
    await this.forgetUnassignedLock(lockImei);
    this.invalidateBikesCache();
    return { bike: (await this.getBike(id))! };
  }

  // The lock is now in the registry, so its discovery row is noise. Best-effort:
  // listUnassignedLocks already excludes assigned IMEIs, so failing to clean up
  // is cosmetic and must not fail the bike that was successfully created.
  private async forgetUnassignedLock(imei: string): Promise<void> {
    try {
      await db.delete(unassignedLocks).where(eq(unassignedLocks.imei, imei));
    } catch {
      /* ignore */
    }
  }

  // Keep the registry's explicit bike_id relationship in step with the legacy
  // bikes.lock_imei binding. Rows may be absent for old/manual bindings, so an
  // UPDATE affecting zero rows is intentional and must not reject the bike save.
  private async syncLockRegistryBinding(imei: string, bikeId: string | null): Promise<void> {
    await db.update(locks).set({ bikeId, updatedAt: Date.now() } as any).where(eq(locks.imei, imei));
  }

  async adminUpdateBike(id: string, patch: AdminUpdateBikeInput) {
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
      if (this.isUniqueViolation(err)) return { error: DatabaseStorage.LOCK_TAKEN };
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
  async archiveBike(id: string) {
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
  async deleteBike(id: string) {
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
  // ---------- Parkings: read + admin CRUD ----------
  // Public callers get active, non-archived points only. The admin page passes
  // includeInactive/includeArchived to see the full set.
  async listParkings(opts?: { includeInactive?: boolean; includeArchived?: boolean }) {
    let rows = (await db.select().from(parkings)) as Parking[];
    if (!opts?.includeArchived) rows = rows.filter((p) => !p.archivedAt);
    if (!opts?.includeInactive) rows = rows.filter((p) => p.status === "active");
    // «Занято» считается динамически: число велосипедов, у которых эта
    // парковка указана как домашняя И которые физически на месте.
    // Арендованный/архивный велосипед стойку не занимает. Перекрывает
    // статичное поле occupied из БД — оно больше не ведётся вручную.
    const bikeRows = await this.listBikes({ includeArchived: false });
    const AT_STATION = new Set(["available", "reserved", "maintenance", "offline", "storage"]);
    const counts = new Map<string, number>();
    for (const b of bikeRows) {
      if (!b.parkingId) continue;
      if (!AT_STATION.has(b.status)) continue;
      counts.set(b.parkingId, (counts.get(b.parkingId) ?? 0) + 1);
    }
    return rows.map((p) => ({ ...p, occupied: counts.get(p.id) ?? 0 }));
  }
  async getParking(id: string) {
    return (await db.select().from(parkings).where(eq(parkings.id, id)).limit(1))[0] as Parking | undefined;
  }

  // Generate the next free P-NN id when the operator doesn't supply one. Just
  // a candidate picker — NOT a reservation. createParking() below is the one
  // responsible for making the actual claim race-safe.
  private async nextParkingId(): Promise<string> {
    const ids = ((await db.select({ id: parkings.id }).from(parkings)) as { id: string }[]).map((r) => r.id);
    let n = 1;
    while (ids.includes(`P-${String(n).padStart(2, "0")}`)) n++;
    return `P-${String(n).padStart(2, "0")}`;
  }

  async createParking(input: AdminCreateParkingInput) {
    const now = Date.now();
    const occupied = Math.min(input.occupied, input.capacity);
    const values = (id: string) => ({
      id,
      name: input.name.trim(),
      city: input.city,
      lat: input.lat,
      lng: input.lng,
      capacity: input.capacity,
      occupied,
      radius: input.radius,
      status: input.status,
      notes: this.optStr(input.notes),
      archivedAt: null,
      seed: false,
      createdAt: now,
      updatedAt: now,
    });

    // Audit: nextParkingId() used to scan for a free id, then createParking
    // separately checked getParking(id) before inserting — two check-then-act
    // gaps a concurrent create could land in between. `parkings.id` is the
    // primary key, so instead of checking first we always insert directly and
    // let Postgres be the arbiter: a genuine conflict surfaces as 23505.
    if (input.id && input.id.trim().length > 0) {
      const id = input.id.trim().toUpperCase();
      try {
        await db.insert(parkings).values(values(id) as any);
      } catch (err) {
        if (this.isUniqueViolation(err)) return { error: "Парковка с таким кодом уже существует" };
        throw err;
      }
      return { parking: (await this.getParking(id))! };
    }

    // No explicit id: pick the next free P-NN slot and insert directly. If
    // another concurrent create just took that exact id, retry with the next
    // free slot instead of surfacing a spurious "already exists" — the
    // operator asked for "any free code", not that specific one.
    const MAX_ATTEMPTS = 50;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = await this.nextParkingId();
      try {
        await db.insert(parkings).values(values(candidate) as any);
        return { parking: (await this.getParking(candidate))! };
      } catch (err) {
        if (this.isUniqueViolation(err)) continue;
        throw err;
      }
    }
    return { error: "Не удалось выделить код парковки — попробуйте ещё раз" };
  }

  async updateParking(id: string, patch: AdminUpdateParkingInput) {
    const existing = await this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    const set: Partial<Parking> = {};
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.city !== undefined) set.city = patch.city;
    if (patch.lat !== undefined) set.lat = patch.lat;
    if (patch.lng !== undefined) set.lng = patch.lng;
    if (patch.capacity !== undefined) set.capacity = patch.capacity;
    if (patch.occupied !== undefined) set.occupied = patch.occupied;
    if (patch.radius !== undefined) set.radius = patch.radius;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.notes !== undefined) set.notes = this.optStr(patch.notes);
    // Keep occupied within the (possibly new) capacity bound.
    const cap = set.capacity ?? existing.capacity;
    const occ = set.occupied ?? existing.occupied;
    if (occ > cap) set.occupied = cap;
    set.updatedAt = Date.now();
    await db.update(parkings).set(set as any).where(eq(parkings.id, id));
    return { parking: (await this.getParking(id))! };
  }

  // Soft delete: stamp archivedAt so the point drops out of every list while
  // staying referenceable from bikes/history that point at its id.
  async archiveParking(id: string) {
    const existing = await this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    await db.update(parkings).set({ archivedAt: Date.now(), updatedAt: Date.now() } as any).where(eq(parkings.id, id));
    return { parking: (await this.getParking(id))! };
  }

  // Undo a soft delete: clear archivedAt and force status to inactive so the
  // point returns muted on the admin maps but never re-appears on the public
  // map until an operator explicitly re-activates it.
  async restoreParking(id: string) {
    const existing = await this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    if (!existing.archivedAt) return { error: "Парковка не в архиве" };
    await db.update(parkings).set({ archivedAt: null, status: "inactive", updatedAt: Date.now() } as any).where(eq(parkings.id, id));
    return { parking: (await this.getParking(id))! };
  }

  // Hard delete: only when no bike references this parking. Otherwise archive so
  // bike.parkingId never dangles.
  async deleteParking(id: string) {
    const existing = await this.getParking(id);
    if (!existing) return { error: "Парковка не найдена" };
    const refCount = (await db.select({ c: count() }).from(bikes).where(eq(bikes.parkingId, id)))[0].c;
    if (refCount > 0) {
      await db.update(parkings).set({ archivedAt: Date.now(), updatedAt: Date.now() } as any).where(eq(parkings.id, id));
      return { error: "К парковке привязаны велосипеды — она переведена в архив", archived: (await this.getParking(id))! };
    }
    await db.delete(parkings).where(eq(parkings.id, id));
    return { ok: true as const };
  }

  async listZones() { return (await db.select().from(zones)) as ZoneRow[]; }

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
  private async loadRidePoints(
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
  private async hydrateTrack(ride: Ride | undefined): Promise<Ride | undefined> {
    if (!ride) return ride;
    if (ride.status !== "active") return ride;
    const pts = await this.loadRidePoints(ride.id);
    if (pts.length === 0) return ride;
    return { ...ride, track: JSON.stringify(pts) };
  }

  async startRide({ bikeId, userId, tariff, prepaid }: { bikeId: string; userId: string; tariff: string; prepaid?: boolean }) {
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
          const track: [number, number, number][] = [[bike.lng, bike.lat, startedAt]];
          const row = (await tx.insert(rides).values({
            bikeId, userId, startedAt,
            startLat: bike.lat, startLng: bike.lng,
            track: JSON.stringify(track), distanceM: 0, cost: costKopecks, tariff, status: "active",
          }).returning())[0] as Ride;
          await tx.update(bikes).set({ status: "rented", updatedAt: Date.now() } as any)
            .where(eq(bikes.id, bikeId));
          // Seed the append-only points table with the start point so the live
          // track (hydrated from ride_points) is never empty for a fresh ride.
          await tx.execute(sql`INSERT INTO ride_points (ride_id, x, y, t) VALUES (${row.id}, ${bike.lng}, ${bike.lat}, ${startedAt})`);
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
  private async abortUnstartedRide(rideId: number, opts: { refundKopecks: number }) {
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

  async appendRidePoint(rideId: number, x: number, y: number) {
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
  async insertBikeTelemetry(bikeId: string, x: number, y: number, t: number) {
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

  async endRide(rideId: number) {
    // Atomic: completing a ride touches four tables (ride, bike, wallet,
    // payment ledger). Doing them as separate statements risks a partial state
    // if the process dies mid-way — e.g. wallet debited but ride still active,
    // or bike freed without a charge recorded. One transaction keeps them
    // consistent: either the whole settlement lands or none of it does.
    const result = await db.transaction(async (tx) => {
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

      // Hourly prepaid model. The tariff was paid at start (r.cost holds the
      // prepaid tariff price, in kopecks). If the rider kept the bike past the
      // paid window, auto-extend by charging one OVERAGE_HOUR_PRICE per started
      // extra hour. Rides on an unknown/legacy tariff (durationHours unknown)
      // skip overage and just settle at the recorded cost.
      const tariffDef = TARIFFS.find((t) => t.id === r.tariff);
      const paidMs = (tariffDef?.durationHours ?? 0) * 60 * 60 * 1000;
      const usedMs = endedAt - r.startedAt;
      const { extraHours, overageKopecks } = computeOverage(usedMs, paidMs);
      const finalCost = finalRideCost(r.cost, overageKopecks);

      await tx.update(rides).set({
        endedAt, status: "completed", cost: finalCost,
        endLat: last[1], endLng: last[0],
        track: JSON.stringify(track),
      }).where(eq(rides.id, rideId));
      await tx.update(bikes).set({ status: "available", lat: last[1], lng: last[0], lastSeen: endedAt, idleHours: 0 } as any)
        .where(eq(bikes.id, r.bikeId));
      // Assignment is based only on live, active parkings. Keep it inside the
      // ride-completion transaction, so the bike never becomes available with
      // an outdated parking reference if the transaction rolls back.
      const parkingMatch = findNearestParkingWithinRadius(
        last[1],
        last[0],
        (await tx.select().from(parkings)) as Parking[],
      );
      await tx.update(bikes).set({ parkingId: parkingMatch?.id ?? null } as any)
        .where(eq(bikes.id, r.bikeId));

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
          description: `Продление аренды ${r.bikeId} • +${extraHours} ч`, createdAt: endedAt,
        });
      }
      return {
        ride: (await tx.select().from(rides).where(eq(rides.id, rideId)).limit(1))[0] as Ride,
        overageKopecks,
      };
    });
    // Ended ride freed the bike (status "available") → refresh the map list and
    // push a terminal event so the rider's SSE stream sends null (ride over).
    if (result?.ride) {
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
    }
    return result?.ride;
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

}

export const storage = new DatabaseStorage();

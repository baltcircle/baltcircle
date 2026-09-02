import { parkings, bikes, zones } from "@shared/schema";
import type { Parking, ZoneRow, AdminCreateParkingInput, AdminUpdateParkingInput, Bike } from "@shared/schema";
import { eq, count } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IParkingStorage, IBikeStorage } from "./interfaces";

export function ParkingMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IParkingStorage {
    // Public callers get active, non-archived points only. The admin page passes
    // includeInactive/includeArchived to see the full set.
    async listParkings(
      this: Pick<IBikeStorage, "listBikes">,
      opts?: { includeInactive?: boolean; includeArchived?: boolean },
    ) {
      let rows = (await db.select().from(parkings)) as Parking[];
      if (!opts?.includeArchived) rows = rows.filter((p) => !p.archivedAt);
      if (!opts?.includeInactive) rows = rows.filter((p) => p.status === "active");
      // «Занято» считается динамически: число велосипедов, у которых эта
      // парковка указана как домашняя И которые физически на месте.
      // Арендованный/архивный велосипед стойку не занимает. Перекрывает
      // статичное поле occupied из БД — оно больше не ведётся вручную.
      const bikeRows = await this.listBikes({ includeArchived: false });
      // "sleeping" (bike-status lifecycle spec, 2026-09): an operator-put-to-sleep
      // lock still sits physically in its home slot, exactly like "storage"/"offline"
      // — it just doesn't report GPS while asleep, so it must still count as occupying
      // the station rather than silently freeing up a slot nobody can actually use.
      const AT_STATION = new Set(["available", "reserved", "maintenance", "offline", "storage", "sleeping"]);
      const counts = new Map<string, number>();
      for (const b of bikeRows as Bike[]) {
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
    //
    // Public rather than private: createParking references this through an
    // explicit `this: {...}` structural parameter type (same rule as
    // optStr/isUniqueViolation in base.ts — a private member can't satisfy a
    // plain object type from outside the declaring method).
    async nextParkingId(): Promise<string> {
      const ids = ((await db.select({ id: parkings.id }).from(parkings)) as { id: string }[]).map((r) => r.id);
      let n = 1;
      while (ids.includes(`P-${String(n).padStart(2, "0")}`)) n++;
      return `P-${String(n).padStart(2, "0")}`;
    }

    async createParking(
      this: { optStr(v: string | undefined): string | null; isUniqueViolation(err: unknown): boolean; nextParkingId(): Promise<string>; getParking(id: string): Promise<Parking | undefined> },
      input: AdminCreateParkingInput,
    ) {
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

    async updateParking(
      this: { getParking(id: string): Promise<Parking | undefined>; optStr(v: string | undefined): string | null },
      id: string,
      patch: AdminUpdateParkingInput,
    ) {
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

    // Soft delete: stamp archivedAt AND force status to inactive so the point
    // drops out of the public map immediately (status is no longer operator-
    // editable — archive/restore is now the only lifecycle control, mirroring
    // bikes) while staying referenceable from bikes/history that point at its id.
    async archiveParking(
      this: { getParking(id: string): Promise<Parking | undefined> },
      id: string,
    ) {
      const existing = await this.getParking(id);
      if (!existing) return { error: "Парковка не найдена" };
      await db.update(parkings).set({ archivedAt: Date.now(), status: "inactive", updatedAt: Date.now() } as any).where(eq(parkings.id, id));
      return { parking: (await this.getParking(id))! };
    }

    // Undo a soft delete: clear archivedAt and restore status to active — with
    // the Статус control removed from the admin UI, archive/restore is the only
    // lifecycle toggle, so restoring must bring the point straight back to live
    // (public-visible), analogous to un-archiving a bike.
    async restoreParking(
      this: { getParking(id: string): Promise<Parking | undefined> },
      id: string,
    ) {
      const existing = await this.getParking(id);
      if (!existing) return { error: "Парковка не найдена" };
      if (!existing.archivedAt) return { error: "Парковка не в архиве" };
      await db.update(parkings).set({ archivedAt: null, status: "active", updatedAt: Date.now() } as any).where(eq(parkings.id, id));
      return { parking: (await this.getParking(id))! };
    }

    // Hard delete: only when no bike references this parking. Otherwise archive so
    // bike.parkingId never dangles.
    async deleteParking(
      this: { getParking(id: string): Promise<Parking | undefined> },
      id: string,
    ) {
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
  };
}

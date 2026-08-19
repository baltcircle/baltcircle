import { locks } from "@shared/schema";
import type { Lock, AdminCreateLockInput, AdminUpdateLockInput } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { ILockStorage, IBikeStorage } from "./interfaces";

export function LockMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements ILockStorage {
    async listLocks(): Promise<Lock[]> {
      return await db.select().from(locks).orderBy(desc(locks.createdAt)) as Lock[];
    }

    async createLock(
      this: Pick<IBikeStorage, "getBike"> & {
        optStr(v: string | undefined): string | null;
        isUniqueViolation(err: unknown): boolean;
      },
      input: AdminCreateLockInput,
    ): Promise<{ lock: Lock } | { error: string }> {
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

    async updateLock(
      this: Pick<IBikeStorage, "getBike"> & {
        optStr(v: string | undefined): string | null;
      },
      id: number,
      patch: AdminUpdateLockInput,
    ): Promise<{ lock: Lock } | { error: string }> {
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
  };
}

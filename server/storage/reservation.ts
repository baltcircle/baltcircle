import { bikes, reservations } from "@shared/schema";
import type { Reservation, Bike } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { RESERVATION_TTL_MS, MAX_ACTIVE_RIDES_PER_USER } from "@shared/geo";
import { db } from "../db/bootstrap";
import { log } from "../logger";
import { getLockGateway } from "../omni/gateway";
import type { Constructor } from "./mixin";
import type { IReservationStorage } from "./interfaces";

export function ReservationMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IReservationStorage {
    async createReservation(
      this: { invalidateBikesCache(opts?: { silent?: boolean }): void; isUniqueViolation(err: unknown): boolean },
      { bikeId, userId }: { bikeId: string; userId: string },
    ): Promise<{ reservation: Reservation } | { error: string }> {
      let lockImei: string | null = null;
      try {
        const result = await db.transaction(async (tx) => {
          // Row-lock the bike so a concurrent reservation/ride-start for the
          // SAME bike cannot both observe "available" before either commits
          // (same double-booking hazard as startRide — see ride.ts).
          const bike = (await tx.select().from(bikes).where(eq(bikes.id, bikeId)).for("update").limit(1))[0] as Bike | undefined;
          if (!bike) return { error: "Велосипед не найден" };
          if (bike.status !== "available") {
            return { error: `Велосипед сейчас «${bike.status}» — забронировать нельзя` };
          }
          lockImei = bike.lockImei;

          // Product rule (2026-09): active reservations and active rides share
          // one combined budget, MAX_ACTIVE_RIDES_PER_USER (shared/geo.ts) — a
          // rider may hold that many bikes total, in any mix of "booked" and
          // "riding". There may be zero, one, or (once this ships) two existing
          // reservation rows to lock, so a plain FOR UPDATE on `reservations`
          // can't serialise this the way the per-bike check above does — take
          // the SAME per-user advisory lock startRide (ride.ts) takes before
          // its own count check, so a reservation attempt and a ride-start
          // attempt for the same rider can never both observe "1 used, 1 free"
          // and both proceed past the combined cap.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
          const existingForUser = await tx.select().from(reservations)
            .where(sql`${reservations.userId} = ${userId} AND ${reservations.status} = 'active'`) as Reservation[];
          const activeRide = await tx.execute(
            sql`SELECT id FROM rides WHERE user_id = ${userId} AND status = 'active'`,
          );
          if (existingForUser.length + activeRide.rows.length >= MAX_ACTIVE_RIDES_PER_USER) {
            return {
              error: MAX_ACTIVE_RIDES_PER_USER === 1
                ? "У вас уже есть активная бронь или поездка"
                : `У вас уже максимум активных бронирований и поездок (${MAX_ACTIVE_RIDES_PER_USER}) — отмените бронь, дождитесь её истечения или завершите поездку`,
            };
          }

          const now = Date.now();
          const row = (await tx.insert(reservations).values({
            bikeId,
            userId,
            createdAt: now,
            expiresAt: now + RESERVATION_TTL_MS,
            status: "active",
          } as any).returning())[0] as Reservation;
          await tx.update(bikes).set({ status: "reserved", updatedAt: now } as any).where(eq(bikes.id, bikeId));
          return { reservation: row };
        });
        if (!("error" in result)) {
          this.invalidateBikesCache();
          // GPS-interval sync (bike-status lifecycle spec, 2026-09): "reserved"
          // tracks at ride-grade precision. Fire-and-forget, outside the tx.
          if (lockImei) getLockGateway()?.syncGpsTrackingForStatus(lockImei, bikeId, "reserved");
        }
        return result;
      } catch (err) {
        // idx_reservations_active_bike (bootstrap.ts) is the DB-level backstop
        // for the same per-bike race the FOR UPDATE lock above already closes
        // in the normal case. The per-user combined cap has no DB-level unique
        // index behind it (no slot column on reservations) — it relies solely
        // on the advisory lock above for race-freedom.
        if (this.isUniqueViolation(err)) {
          return { error: "Не удалось создать бронь — велосипед уже забронирован" };
        }
        throw err;
      }
    }

    async getActiveReservations(userId: string): Promise<Reservation[]> {
      return (await db.select().from(reservations)
        .where(sql`${reservations.userId} = ${userId} AND ${reservations.status} = 'active'`)) as Reservation[];
    }

    async getActiveReservationForBike(bikeId: string): Promise<Reservation | undefined> {
      return (await db.select().from(reservations)
        .where(sql`${reservations.bikeId} = ${bikeId} AND ${reservations.status} = 'active'`)
        .limit(1))[0] as Reservation | undefined;
    }

    async cancelReservation(
      this: { invalidateBikesCache(opts?: { silent?: boolean }): void },
      id: number,
      userId: string,
    ): Promise<{ ok: true } | { error: string }> {
      let freedLockImei: string | null | undefined;
      let freedBikeId: string | undefined;
      const result = await db.transaction(async (tx) => {
        const row = (await tx.select().from(reservations).where(eq(reservations.id, id)).for("update").limit(1))[0] as Reservation | undefined;
        if (!row) return { error: "Бронь не найдена" };
        if (row.userId !== userId) return { error: "Это не ваша бронь" };
        if (row.status !== "active") return { error: "Бронь уже неактивна" };
        await tx.update(reservations).set({ status: "cancelled" } as any).where(eq(reservations.id, id));
        // Only flip the bike back to "available" if it's still sitting in
        // "reserved" for THIS reservation's bike — a claimed reservation
        // (bike now "rented") must never be touched by a cancel that raced
        // in after the ride already started.
        const freed = await tx.update(bikes).set({ status: "available", updatedAt: Date.now() } as any)
          .where(sql`${bikes.id} = ${row.bikeId} AND ${bikes.status} = 'reserved'`)
          .returning({ lockImei: bikes.lockImei });
        if (freed.length > 0) {
          freedLockImei = freed[0].lockImei;
          freedBikeId = row.bikeId;
        }
        return { ok: true as const };
      });
      if (!("error" in result)) {
        this.invalidateBikesCache();
        // GPS-interval sync (bike-status lifecycle spec, 2026-09): back to
        // "available" cadence. Fire-and-forget, outside the tx.
        if (freedLockImei && freedBikeId) {
          getLockGateway()?.syncGpsTrackingForStatus(freedLockImei, freedBikeId, "available");
        }
      }
      return result;
    }

    async expireOverdueReservations(): Promise<number> {
      // Single-statement sweep (no app-level loop): flip every overdue
      // "active" row to "expired" and free its bike in one transaction, so a
      // crash mid-sweep can never leave a reservation "expired" with its bike
      // still stuck "reserved" (or vice versa).
      const now = Date.now();
      let expiredCount = 0;
      const freedLocks: { bikeId: string; lockImei: string | null }[] = [];
      try {
        await db.transaction(async (tx) => {
          const overdue = await tx.execute(
            sql`SELECT id, bike_id FROM reservations WHERE status = 'active' AND expires_at <= ${now} FOR UPDATE`,
          );
          const rows = overdue.rows as { id: number; bike_id: string }[];
          if (rows.length === 0) return;
          const ids = rows.map((r) => r.id);
          await tx.execute(sql`UPDATE reservations SET status = 'expired' WHERE id = ANY(${ids})`);
          for (const r of rows) {
            const freed = await tx.execute(
              sql`UPDATE bikes SET status = 'available', updated_at = ${now} WHERE id = ${r.bike_id} AND status = 'reserved' RETURNING lock_imei`,
            );
            if (freed.rows.length > 0) {
              freedLocks.push({ bikeId: r.bike_id, lockImei: (freed.rows[0] as { lock_imei: string | null }).lock_imei });
            }
          }
          expiredCount = rows.length;
        });
      } catch (err) {
        log(`[reservations] sweep failed: ${(err as Error)?.message ?? "?"}`, "reservations");
        throw err;
      }
      if (expiredCount > 0) {
        (this as unknown as { invalidateBikesCache(opts?: { silent?: boolean }): void }).invalidateBikesCache({ silent: true });
        // GPS-interval sync (bike-status lifecycle spec, 2026-09): back to
        // "available" cadence for every bike this sweep freed.
        for (const { bikeId, lockImei } of freedLocks) {
          if (lockImei) getLockGateway()?.syncGpsTrackingForStatus(lockImei, bikeId, "available");
        }
      }
      return expiredCount;
    }
  };
}

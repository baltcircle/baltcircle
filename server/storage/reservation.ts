import { bikes, reservations } from "@shared/schema";
import type { Reservation, Bike } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { RESERVATION_TTL_MS } from "@shared/geo";
import { db } from "../db/bootstrap";
import { log } from "../logger";
import type { Constructor } from "./mixin";
import type { IReservationStorage } from "./interfaces";

export function ReservationMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IReservationStorage {
    async createReservation(
      this: { invalidateBikesCache(opts?: { silent?: boolean }): void; isUniqueViolation(err: unknown): boolean },
      { bikeId, userId }: { bikeId: string; userId: string },
    ): Promise<{ reservation: Reservation } | { error: string }> {
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

          // Product rule (explicit user decision): ONE active reservation at a
          // time, across any bike. Read-then-check inside the tx is enough to
          // be race-free against a SECOND createReservation for the same user
          // only because idx_reservations_active_user (bootstrap.ts) backs it
          // at the DB level too — a racing insert would hit a unique-violation
          // and land in the catch below instead of silently succeeding twice.
          const existingForUser = (await tx.select().from(reservations)
            .where(sql`${reservations.userId} = ${userId} AND ${reservations.status} = 'active'`)
            .limit(1))[0] as Reservation | undefined;
          if (existingForUser) {
            return { error: "У вас уже есть активная бронь — отмените её или дождитесь истечения" };
          }
          const activeRide = await tx.execute(
            sql`SELECT id FROM rides WHERE user_id = ${userId} AND status = 'active' LIMIT 1`,
          );
          if (activeRide.rows.length > 0) {
            return { error: "У вас уже есть активная поездка" };
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
        if (!("error" in result)) this.invalidateBikesCache();
        return result;
      } catch (err) {
        // idx_reservations_active_bike / idx_reservations_active_user
        // (bootstrap.ts) are the DB-level backstop for the same race the
        // FOR UPDATE lock above already closes in the normal case.
        if (this.isUniqueViolation(err)) {
          return { error: "Не удалось создать бронь — велосипед уже забронирован или у вас уже есть активная бронь" };
        }
        throw err;
      }
    }

    async getActiveReservationForUser(userId: string): Promise<Reservation | undefined> {
      return (await db.select().from(reservations)
        .where(sql`${reservations.userId} = ${userId} AND ${reservations.status} = 'active'`)
        .limit(1))[0] as Reservation | undefined;
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
        await tx.update(bikes).set({ status: "available", updatedAt: Date.now() } as any)
          .where(sql`${bikes.id} = ${row.bikeId} AND ${bikes.status} = 'reserved'`);
        return { ok: true as const };
      });
      if (!("error" in result)) this.invalidateBikesCache();
      return result;
    }

    async expireOverdueReservations(): Promise<number> {
      // Single-statement sweep (no app-level loop): flip every overdue
      // "active" row to "expired" and free its bike in one transaction, so a
      // crash mid-sweep can never leave a reservation "expired" with its bike
      // still stuck "reserved" (or vice versa).
      const now = Date.now();
      let expiredCount = 0;
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
            await tx.execute(
              sql`UPDATE bikes SET status = 'available', updated_at = ${now} WHERE id = ${r.bike_id} AND status = 'reserved'`,
            );
          }
          expiredCount = rows.length;
        });
      } catch (err) {
        log(`[reservations] sweep failed: ${(err as Error)?.message ?? "?"}`, "reservations");
        throw err;
      }
      if (expiredCount > 0) {
        (this as unknown as { invalidateBikesCache(opts?: { silent?: boolean }): void }).invalidateBikesCache({ silent: true });
      }
      return expiredCount;
    }
  };
}

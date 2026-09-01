import { rideFeedback, feedbackTierForRating, FEEDBACK_REASON_IDS, rides, users } from "@shared/schema";
import type { RideFeedback, CreateRideFeedbackInput, AdminRideFeedback, User } from "@shared/schema";
import { count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IFeedbackStorage } from "./interfaces";

export function FeedbackMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IFeedbackStorage {
    // Validates reasons against the pool for the submitted rating's tier
    // (not just shape — content, so analytics never see garbage ids from a
    // stale client build) then upserts by rideId. One feedback per ride:
    // resubmitting (e.g. the dialog reopened after a refresh) replaces the
    // previous answer rather than creating a duplicate row.
    async submitRideFeedback(
      rideId: number,
      userId: string,
      input: CreateRideFeedbackInput,
    ): Promise<RideFeedback | { error: string }> {
      const tier = feedbackTierForRating(input.rating);
      const allowed = new Set(FEEDBACK_REASON_IDS[tier]);
      const reasons = Array.from(new Set(input.reasons));
      for (const r of reasons) {
        if (!allowed.has(r)) return { error: "Некорректная причина отзыва" };
      }
      const comment = (input.comment ?? "").trim();
      const now = Date.now();
      const row = (await db.insert(rideFeedback).values({
        rideId,
        userId,
        rating: input.rating,
        reasons,
        comment: comment || null,
        createdAt: now,
      }).onConflictDoUpdate({
        target: rideFeedback.rideId,
        set: { rating: input.rating, reasons, comment: comment || null, createdAt: now },
      }).returning())[0] as RideFeedback;
      return row;
    }

    async getRideFeedback(rideId: number): Promise<RideFeedback | undefined> {
      return (await db.select().from(rideFeedback).where(eq(rideFeedback.rideId, rideId)).limit(1))[0] as
        | RideFeedback
        | undefined;
    }

    // Admin Reviews list, newest first, enriched with the bike id (via the
    // ride) and the rider's name/phone (via the feedback's own userId —
    // always the ride owner, never the acting staff session, see
    // submitRideFeedback). Two batched `IN` queries instead of one per row,
    // mirroring listAdminRides' existing pattern.
    async listRideFeedback(opts?: { limit?: number; offset?: number }): Promise<AdminRideFeedback[]> {
      const limit = opts?.limit ?? 500;
      const offset = opts?.offset ?? 0;
      const rows = (await db.select().from(rideFeedback)
        .orderBy(desc(rideFeedback.createdAt))
        .limit(limit)
        .offset(offset)) as RideFeedback[];
      if (rows.length === 0) return [];

      const rideIds = Array.from(new Set(rows.map((r) => r.rideId)));
      const userIds = Array.from(new Set(rows.map((r) => r.userId)));
      const [rideRows, userRows] = await Promise.all([
        db.select({ id: rides.id, bikeId: rides.bikeId }).from(rides).where(inArray(rides.id, rideIds)),
        db.select().from(users).where(inArray(users.id, userIds)),
      ]);
      const bikeByRide = new Map((rideRows as { id: number; bikeId: string }[]).map((r) => [r.id, r.bikeId]));
      const userById = new Map((userRows as User[]).map((u) => [u.id, u]));

      return rows.map((r) => {
        const u = userById.get(r.userId);
        return {
          ...r,
          bikeId: bikeByRide.get(r.rideId) ?? null,
          userName: u?.name ?? null,
          userPhone: u?.phone ?? null,
        };
      });
    }

    async countRideFeedback(): Promise<number> {
      return (await db.select({ c: count() }).from(rideFeedback))[0].c;
    }
  };
}

import { rideFeedback, feedbackTierForRating, FEEDBACK_REASON_IDS } from "@shared/schema";
import type { RideFeedback, CreateRideFeedbackInput } from "@shared/schema";
import { eq } from "drizzle-orm";
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
  };
}

ALTER TABLE "reservations" ADD COLUMN "notified_mask" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "pause_notified_mask" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "pause_notified_for" bigint;--> statement-breakpoint
CREATE INDEX "idx_rides_paused" ON "rides" USING btree ("paused_at") WHERE "rides"."status" = 'active' AND "rides"."paused_at" IS NOT NULL;
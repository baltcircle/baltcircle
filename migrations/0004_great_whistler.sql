CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"bike_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'high' NOT NULL,
	"message" text NOT NULL,
	"created_at" bigint NOT NULL,
	"acknowledged_at" bigint,
	"acknowledged_by" text
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"bike_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"claimed_ride_id" integer
);
--> statement-breakpoint
ALTER TABLE "bikes" ADD COLUMN "maintenance_reason" text;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "paid_until_at" bigint;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "paused_at" bigint;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "total_paused_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "overage_notified_at" bigint;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "start_parking_id" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_claimed_ride_id_rides_id_fk" FOREIGN KEY ("claimed_ride_id") REFERENCES "public"."rides"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_alerts_bike" ON "alerts" USING btree ("bike_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_created" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_alerts_unacked" ON "alerts" USING btree ("created_at") WHERE "alerts"."acknowledged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_reservations_bike" ON "reservations" USING btree ("bike_id");--> statement-breakpoint
CREATE INDEX "idx_reservations_user_status" ON "reservations" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_reservations_active_expires" ON "reservations" USING btree ("expires_at") WHERE "reservations"."status" = 'active';--> statement-breakpoint
-- NOT VALID: same zero-downtime pattern as 0003_bikes_parking_fk.sql — skips
-- the full-table validation scan/lock on the live "rides" table at migration
-- time (all existing rows have start_parking_id IS NULL anyway, so a later
-- `VALIDATE CONSTRAINT` run manually during low traffic is a formality).
ALTER TABLE "rides" ADD CONSTRAINT "rides_start_parking_id_parkings_id_fk" FOREIGN KEY ("start_parking_id") REFERENCES "public"."parkings"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "idx_rides_status_paid_until" ON "rides" USING btree ("status","paid_until_at");--> statement-breakpoint
-- Data backfill (hand-written, not drizzle-kit-generated): rides started
-- before this migration never had paid_until_at. Compute it from the tariff
-- the rider actually paid for (h1/h2/h3 -> 1h/2h/3h), so endRide's overage
-- calculation (which now reads paid_until_at instead of re-deriving it from
-- TARIFFS every time) sees the same deadline it always implied. Only touches
-- still-active rides; completed/aborted rides already have a fixed cost and
-- don't need a synthetic deadline. Guarded by IS NULL for idempotent re-runs.
UPDATE "rides" SET "paid_until_at" = "started_at" + CASE "tariff"
    WHEN 'h1' THEN 3600000
    WHEN 'h2' THEN 7200000
    WHEN 'h3' THEN 10800000
    ELSE 3600000
  END
  WHERE "status" = 'active' AND "paid_until_at" IS NULL;

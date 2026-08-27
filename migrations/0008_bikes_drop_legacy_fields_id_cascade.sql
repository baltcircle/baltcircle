ALTER TABLE "alerts" DROP CONSTRAINT "alerts_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "locks" DROP CONSTRAINT "locks_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "rides" DROP CONSTRAINT "rides_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_bike_id_bikes_id_fk";
--> statement-breakpoint
-- NOT VALID: re-adding an FK that was already valid before the DROP above
-- (data already satisfies it) still forces Postgres to re-scan+validate on a
-- plain ADD CONSTRAINT, taking a heavier lock for no reason. NOT VALID skips
-- that scan at ADD time; VALIDATE CONSTRAINT below re-checks it with the much
-- lighter SHARE UPDATE EXCLUSIVE lock instead of blocking concurrent writes.
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE no action ON UPDATE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "locks" ADD CONSTRAINT "locks_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE set null ON UPDATE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE no action ON UPDATE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE no action ON UPDATE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE no action ON UPDATE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_bike_id_bikes_id_fk" FOREIGN KEY ("bike_id") REFERENCES "public"."bikes"("id") ON DELETE no action ON UPDATE cascade NOT VALID;
--> statement-breakpoint
ALTER TABLE "alerts" VALIDATE CONSTRAINT "alerts_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "locks" VALIDATE CONSTRAINT "locks_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "payment_orders" VALIDATE CONSTRAINT "payment_orders_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "reservations" VALIDATE CONSTRAINT "reservations_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "rides" VALIDATE CONSTRAINT "rides_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "tickets" VALIDATE CONSTRAINT "tickets_bike_id_bikes_id_fk";
--> statement-breakpoint
ALTER TABLE "bikes" DROP COLUMN "serial";
--> statement-breakpoint
ALTER TABLE "bikes" DROP COLUMN "lock_id";
--> statement-breakpoint
ALTER TABLE "bikes" DROP COLUMN "external_qr_code";
--> statement-breakpoint
ALTER TABLE "bikes" DROP COLUMN "is_test_bike";

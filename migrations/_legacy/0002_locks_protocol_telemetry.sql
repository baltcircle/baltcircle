-- Gateway-owned protocol state for the Omni Horseshoe Lock. All fields are
-- nullable so already-registered locks and newly provisioned locks begin with
-- no telemetry until the TCP gateway receives a corresponding report.
ALTER TABLE "locks" ADD COLUMN IF NOT EXISTS "last_lock_state" text;
--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN IF NOT EXISTS "last_latitude" numeric;
--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN IF NOT EXISTS "last_longitude" numeric;
--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN IF NOT EXISTS "last_location_at" bigint;
--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN IF NOT EXISTS "ble_key" text;
--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN IF NOT EXISTS "device_type_code" text;
--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN IF NOT EXISTS "last_alarm_type" text;
--> statement-breakpoint
ALTER TABLE "locks" ADD COLUMN IF NOT EXISTS "last_alarm_at" bigint;

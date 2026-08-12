-- Custom SQL is used here because the repository's existing migrations are
-- hand-authored and predate Drizzle's schema snapshot journal. The scaffold was
-- generated with `drizzle-kit generate --custom --name locks_registry`.
CREATE TABLE IF NOT EXISTS "locks" (
  "id" serial PRIMARY KEY NOT NULL,
  "imei" text NOT NULL,
  "mac_address" text,
  "bike_id" text REFERENCES "bikes"("id") ON DELETE SET NULL,
  "sim_iccid" text,
  "firmware_version" text,
  "apn" text DEFAULT 'cmiot' NOT NULL,
  "status" text DEFAULT 'unregistered' NOT NULL,
  "last_seen_at" bigint,
  "last_battery_voltage" numeric,
  "last_signal_strength" integer,
  "notes" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_locks_imei" ON "locks" USING btree ("imei");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locks_bike_id" ON "locks" USING btree ("bike_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locks_status" ON "locks" USING btree ("status");

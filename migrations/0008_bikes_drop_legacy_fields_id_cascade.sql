-- Drop each existing bike_id -> bikes(id) FK by dynamic lookup rather than a
-- hardcoded constraint name: production schema has drifted from what
-- drizzle-kit's naming convention assumes (confirmed live — the assumed name
-- "locks_bike_id_bikes_id_fk" does not exist there), so a fixed-name DROP
-- CONSTRAINT is not safe. Each of these 6 tables has exactly one FK to
-- bikes(id) (confirmed in shared/schema.ts), so conrelid+confrelid alone
-- identifies it unambiguously. No-op (cname stays NULL) if the FK is
-- already absent for any reason.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname FROM pg_constraint con
    WHERE con.contype = 'f' AND con.conrelid = '"alerts"'::regclass AND con.confrelid = '"bikes"'::regclass;
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE "alerts" DROP CONSTRAINT %I', cname); END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname FROM pg_constraint con
    WHERE con.contype = 'f' AND con.conrelid = '"locks"'::regclass AND con.confrelid = '"bikes"'::regclass;
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE "locks" DROP CONSTRAINT %I', cname); END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname FROM pg_constraint con
    WHERE con.contype = 'f' AND con.conrelid = '"payment_orders"'::regclass AND con.confrelid = '"bikes"'::regclass;
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE "payment_orders" DROP CONSTRAINT %I', cname); END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname FROM pg_constraint con
    WHERE con.contype = 'f' AND con.conrelid = '"reservations"'::regclass AND con.confrelid = '"bikes"'::regclass;
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE "reservations" DROP CONSTRAINT %I', cname); END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname FROM pg_constraint con
    WHERE con.contype = 'f' AND con.conrelid = '"rides"'::regclass AND con.confrelid = '"bikes"'::regclass;
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE "rides" DROP CONSTRAINT %I', cname); END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname FROM pg_constraint con
    WHERE con.contype = 'f' AND con.conrelid = '"tickets"'::regclass AND con.confrelid = '"bikes"'::regclass;
  IF cname IS NOT NULL THEN EXECUTE format('ALTER TABLE "tickets" DROP CONSTRAINT %I', cname); END IF;
END $$;
--> statement-breakpoint
-- NOT VALID: re-adding an FK that was already valid before the DROP above
-- (data already satisfies it) still forces Postgres to re-scan+validate on a
-- plain ADD CONSTRAINT, taking a heavier lock for no reason. NOT VALID skips
-- that scan at ADD time; VALIDATE CONSTRAINT below re-checks it with the much
-- lighter SHARE UPDATE EXCLUSIVE lock instead of blocking concurrent writes.
-- Fixed names below establish the drizzle-default naming going forward, so
-- future drizzle-kit generate diffs match the live schema again.
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
ALTER TABLE "bikes" DROP COLUMN IF EXISTS "serial";
--> statement-breakpoint
ALTER TABLE "bikes" DROP COLUMN IF EXISTS "lock_id";
--> statement-breakpoint
ALTER TABLE "bikes" DROP COLUMN IF EXISTS "external_qr_code";
--> statement-breakpoint
ALTER TABLE "bikes" DROP COLUMN IF EXISTS "is_test_bike";

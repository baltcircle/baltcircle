ALTER TABLE "payment_orders" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "total_tariff_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill: populate the brand-new total_tariff_hours column for existing
-- rows from each ride's ORIGINAL tariff at start (not a recompute of cost —
-- that fix intentionally applies only to new rides going forward, per
-- product decision). Every pre-migration row's DEFAULT 0 above is otherwise
-- wrong for anything that isn't a fresh h1 ride, which would show "0 часов"
-- in history/dashboard for every existing extended or h2/h3 ride.
UPDATE "rides" SET "total_tariff_hours" = CASE "tariff"
  WHEN 'h1' THEN 1
  WHEN 'h2' THEN 2
  WHEN 'h3' THEN 3
  ELSE 0
END WHERE "total_tariff_hours" = 0;
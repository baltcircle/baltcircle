-- Per-parking geofence radius for automatic assignment on availability transitions.
-- Existing rows receive the default 30 metre radius through the non-null default.
ALTER TABLE "parkings" ADD COLUMN IF NOT EXISTS "radius" integer NOT NULL DEFAULT 30;

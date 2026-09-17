-- Data migration (hand-written, not drizzle-kit schema-diff): retroactively
-- renumbers every existing parking's id from the old global "P-NN" scheme to
-- the new per-city scheme introduced in 0017 (see shared/schema.ts
-- PARKING_CITY_CODE / nextParkingCode): {CityPrefix}-{NN}, sequence restarts
-- per city, ordered by created_at then id for stable, deterministic
-- assignment. Keeps bikes.parking_id and rides.start_parking_id in sync.
--
-- Both FK constraints (bikes_parking_id_parkings_id_fk,
-- rides_start_parking_id_parkings_id_fk) are ON UPDATE no action, so a
-- direct rename of parkings.id would orphan/violate references. Drop them
-- first, then re-add as NOT VALID at the end (same zero-downtime pattern as
-- migrations 0003/0004 — skips a full-table validation scan; all referencing
-- rows are updated in-place here anyway, so a manual VALIDATE CONSTRAINT
-- later is a formality, not a correctness requirement).
--
-- Renaming parkings.id in a single UPDATE risks a transient PK collision
-- when one row's new id equals another row's not-yet-processed old id
-- (order-dependent "leapfrog" failure). Guarded against with a two-phase
-- rename through a disjoint "__migrating__"-prefixed namespace that cannot
-- collide with either the old "P-NN" ids or the new "{Prefix}-NN" ids.
ALTER TABLE "bikes" DROP CONSTRAINT IF EXISTS "bikes_parking_id_parkings_id_fk";--> statement-breakpoint
ALTER TABLE "rides" DROP CONSTRAINT IF EXISTS "rides_start_parking_id_parkings_id_fk";--> statement-breakpoint

CREATE TEMP TABLE "_parking_id_migration_map" AS
WITH "city_prefix" (city, prefix) AS (
  VALUES
    ('Калининград', 'K'),
    ('Зеленоградск', 'Z'),
    ('Пионерский', 'P'),
    ('Балтийск', 'B'),
    ('Светлогорск', 'S')
)
SELECT
  p."id" AS "old_id",
  cp."prefix" || '-' || lpad(
    row_number() OVER (
      PARTITION BY p."city"
      ORDER BY COALESCE(p."created_at", 0), p."id"
    )::text,
    2,
    '0'
  ) AS "new_id"
FROM "parkings" p
JOIN "city_prefix" cp ON cp."city" = p."city";--> statement-breakpoint

-- Phase 1: move every affected row (and its referrers) into a disjoint
-- temporary namespace so no intermediate value can collide with either an
-- old or a final id.
UPDATE "parkings" p
SET "id" = '__migrating__' || m."old_id"
FROM "_parking_id_migration_map" m
WHERE p."id" = m."old_id";--> statement-breakpoint

UPDATE "bikes" b
SET "parking_id" = '__migrating__' || m."old_id"
FROM "_parking_id_migration_map" m
WHERE b."parking_id" = m."old_id";--> statement-breakpoint

UPDATE "rides" r
SET "start_parking_id" = '__migrating__' || m."old_id"
FROM "_parking_id_migration_map" m
WHERE r."start_parking_id" = m."old_id";--> statement-breakpoint

-- Phase 2: move from the temporary namespace to the final city-prefixed id.
UPDATE "parkings" p
SET "id" = m."new_id"
FROM "_parking_id_migration_map" m
WHERE p."id" = '__migrating__' || m."old_id";--> statement-breakpoint

UPDATE "bikes" b
SET "parking_id" = m."new_id"
FROM "_parking_id_migration_map" m
WHERE b."parking_id" = '__migrating__' || m."old_id";--> statement-breakpoint

UPDATE "rides" r
SET "start_parking_id" = m."new_id"
FROM "_parking_id_migration_map" m
WHERE r."start_parking_id" = '__migrating__' || m."old_id";--> statement-breakpoint

DROP TABLE "_parking_id_migration_map";--> statement-breakpoint

ALTER TABLE "bikes" ADD CONSTRAINT "bikes_parking_id_parkings_id_fk" FOREIGN KEY ("parking_id") REFERENCES "public"."parkings"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_start_parking_id_parkings_id_fk" FOREIGN KEY ("start_parking_id") REFERENCES "public"."parkings"("id") ON DELETE set null ON UPDATE no action NOT VALID;

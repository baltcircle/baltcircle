-- Future-dated telemetry (production, 2026-11-09/10): before the receipt-time
-- clock guard (MAX_GPS_CLOCK_AHEAD_MS, PR #282) some locks stored GPS fixes
-- stamped hours/days ahead — GNSS spoofing shifts the GPS clock too. Those rows
-- look "newest" to every ORDER BY t DESC / time-window query until the clock
-- catches up. Their real time is unknowable and the positions came from a bad
-- receiver state, so they are removed. Keep 120000 in sync with
-- MAX_GPS_CLOCK_AHEAD_MS in shared/geo.ts.
DELETE FROM bike_telemetry
WHERE t > (extract(epoch FROM now()) * 1000)::bigint + 120000;
--> statement-breakpoint
-- A future last_seen_at would also block every later lock report via the
-- NEWEST_REPORT_GUARD (last_seen_at <= at) in server/omni/store.ts. Push such
-- values one hour into the past: stale (not "fresh"), and the next real
-- report overwrites them.
UPDATE locks
SET last_seen_at = (extract(epoch FROM now()) * 1000)::bigint - 3600000
WHERE last_seen_at > (extract(epoch FROM now()) * 1000)::bigint + 120000;
--> statement-breakpoint
UPDATE locks
SET last_location_at = (extract(epoch FROM now()) * 1000)::bigint - 3600000
WHERE last_location_at > (extract(epoch FROM now()) * 1000)::bigint + 120000;
--> statement-breakpoint
UPDATE locks
SET last_alarm_at = (extract(epoch FROM now()) * 1000)::bigint - 3600000
WHERE last_alarm_at > (extract(epoch FROM now()) * 1000)::bigint + 120000;
--> statement-breakpoint
UPDATE bikes
SET last_seen = (extract(epoch FROM now()) * 1000)::bigint - 3600000
WHERE last_seen > (extract(epoch FROM now()) * 1000)::bigint + 120000;
--> statement-breakpoint
UPDATE bikes
SET lock_last_seen = (extract(epoch FROM now()) * 1000)::bigint - 3600000
WHERE lock_last_seen > (extract(epoch FROM now()) * 1000)::bigint + 120000;

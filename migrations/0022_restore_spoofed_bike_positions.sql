-- GNSS spoofing (production, 2026-11-10): BC-002's lock reported a consistent
-- run of accurate-looking fixes ~800 km outside the Kaliningrad region, the
-- relocation re-anchor accepted it, and bikes.lat/lng moved off the map.
-- The server now rejects out-of-area fixes (SERVICE_AREA_BOUNDS in
-- shared/geo.ts — keep the bbox below in sync) and heals a poisoned
-- locks.last_latitude/last_longitude with the next trusted fix. This one-off
-- repair puts affected bikes back at their last trusted in-area telemetry
-- point so they are visible on the map until that fix arrives.
UPDATE bikes AS b
SET lat = good.y, lng = good.x
FROM locks AS l
CROSS JOIN LATERAL (
  SELECT t.x, t.y
  FROM bike_telemetry AS t
  WHERE t.bike_id = l.bike_id
    AND t.x IS NOT NULL AND t.y IS NOT NULL
    AND t.lat BETWEEN 54.25 AND 55.40
    AND t.lng BETWEEN 19.55 AND 22.95
    AND (t.hdop IS NULL OR t.hdop <= 10)
    AND t.t <= (extract(epoch FROM now()) * 1000)::bigint + 120000
  ORDER BY t.t DESC
  LIMIT 1
) AS good
WHERE l.bike_id = b.id
  AND l.last_latitude IS NOT NULL AND l.last_longitude IS NOT NULL
  AND (l.last_latitude NOT BETWEEN 54.25 AND 55.40
       OR l.last_longitude NOT BETWEEN 19.55 AND 22.95);

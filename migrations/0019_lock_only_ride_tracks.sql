CREATE TABLE "ride_lock_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"ride_id" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"t" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ride_lock_points" ADD CONSTRAINT "ride_lock_points_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ride_lock_points_cursor" ON "ride_lock_points" USING btree ("ride_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ride_lock_points_fix" ON "ride_lock_points" USING btree ("ride_id","t","lat","lng");
--> statement-breakpoint
-- Great-circle metres, never the legacy map-units * 30 approximation.
-- Do not invent distance across a lost-signal gap (same 45s as route rendering).
CREATE FUNCTION lock_track_metres(lat1 float8, lng1 float8, t1 bigint,
                                  lat2 float8, lng2 float8, t2 bigint)
RETURNS float8 LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t1 IS NULL OR t2 IS NULL OR t2 <= t1 OR t2 - t1 > 45000 THEN 0
    ELSE 12742000 * asin(sqrt(least(1.0, greatest(0.0,
      power(sin(radians(lat2-lat1)/2),2) +
      cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lng2-lng1)/2),2)))))
  END
$$;
--> statement-breakpoint
-- Bootstrap only currently active rides. Historical records are not rewritten.
INSERT INTO ride_lock_points (ride_id,x,y,lat,lng,t)
SELECT DISTINCT r.id, bt.x, bt.y, bt.lat, bt.lng, bt.t
FROM rides r JOIN bike_telemetry bt ON bt.bike_id=r.bike_id AND bt.t>=r.started_at
WHERE r.status='active' AND bt.t <= (extract(epoch FROM clock_timestamp())*1000)::bigint
  AND bt.imei IS NOT NULL AND bt.x IS NOT NULL AND bt.y IS NOT NULL
  AND bt.lat BETWEEN -90 AND 90 AND bt.lng BETWEEN -180 AND 180
  AND (bt.hdop IS NULL OR bt.hdop<=10)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH segments AS (
  SELECT ride_id, lock_track_metres(
    lag(lat) OVER w, lag(lng) OVER w, lag(t) OVER w, lat,lng,t) AS metres
  FROM ride_lock_points WINDOW w AS (PARTITION BY ride_id ORDER BY t,id)
), totals AS (SELECT ride_id,sum(metres) AS metres FROM segments GROUP BY ride_id)
UPDATE rides r SET distance_m=coalesce((SELECT metres FROM totals WHERE ride_id=r.id),0),
  track='[]' WHERE r.status='active';

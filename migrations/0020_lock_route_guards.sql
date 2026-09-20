ALTER TABLE "rides" ADD COLUMN "lock_track_only" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_rides_bike_started" ON "rides" USING btree ("bike_id","started_at" DESC NULLS LAST);
--> statement-breakpoint
-- Preserve historical rides rather than mixing new fixes with old phone totals.
-- Active rides were rebuilt from lock GPS by 0019; future rides default to true.
UPDATE rides SET lock_track_only=false WHERE status<>'active';
--> statement-breakpoint
-- Persist a lock fix and its distance atomically with raw telemetry, including
-- delayed flushes after ride completion. The ride lock serializes with endRide.
CREATE FUNCTION project_lock_ride_point() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ride_row rides%ROWTYPE;
  previous_point ride_lock_points%ROWTYPE;
  next_point ride_lock_points%ROWTYPE;
  point_id integer;
  delta float8;
BEGIN
  IF NEW.imei IS NULL OR NEW.x IS NULL OR NEW.y IS NULL
    OR NEW.lat IS NULL OR NEW.lng IS NULL
    OR NOT (NEW.lat BETWEEN -90 AND 90 AND NEW.lng BETWEEN -180 AND 180)
    OR (NEW.hdop IS NOT NULL AND NEW.hdop>10) THEN RETURN NEW; END IF;
  SELECT * INTO ride_row FROM rides
    WHERE bike_id=NEW.bike_id AND started_at<=NEW.t AND lock_track_only
      AND (status='active' OR (status='completed' AND ended_at>=NEW.t))
    ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO ride_lock_points (ride_id,x,y,lat,lng,t)
    VALUES (ride_row.id,NEW.x,NEW.y,NEW.lat,NEW.lng,NEW.t)
    ON CONFLICT DO NOTHING RETURNING id INTO point_id;
  IF point_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO previous_point FROM ride_lock_points
    WHERE ride_id=ride_row.id AND (t,id)<(NEW.t,point_id) ORDER BY t DESC,id DESC LIMIT 1;
  SELECT * INTO next_point FROM ride_lock_points
    WHERE ride_id=ride_row.id AND (t,id)>(NEW.t,point_id) ORDER BY t,id LIMIT 1;
  delta := lock_track_metres(previous_point.lat,previous_point.lng,previous_point.t,NEW.lat,NEW.lng,NEW.t)
    + lock_track_metres(NEW.lat,NEW.lng,NEW.t,next_point.lat,next_point.lng,next_point.t)
    - lock_track_metres(previous_point.lat,previous_point.lng,previous_point.t,
                        next_point.lat,next_point.lng,next_point.t);
  UPDATE rides SET distance_m=greatest(0,distance_m+delta) WHERE id=ride_row.id;
  -- A buffered fix can land after endRide's snapshot. Refresh that snapshot
  -- only for completed rides, never rewrite the full active route per point.
  IF ride_row.status='completed' THEN
    UPDATE rides SET track=(SELECT json_agg(json_build_array(x,y,t) ORDER BY t,id)::text
      FROM ride_lock_points WHERE ride_id=ride_row.id) WHERE id=ride_row.id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER bike_telemetry_lock_route AFTER INSERT ON bike_telemetry
FOR EACH ROW EXECUTE FUNCTION project_lock_ride_point();

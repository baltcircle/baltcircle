-- maintenance_reason explains why a bike is out of rotation, so it is only
-- meaningful while status is 'maintenance' or 'offline'. Automatic paths set it
-- (auto:low_battery, auto:lock_open_*), but none of the many paths that return
-- a bike to service cleared it (production, 2026-11-09: BC-002 'available' with
-- a stale auto:low_battery). Enforce the invariant in one place.
CREATE FUNCTION bikes_clear_stale_maintenance_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('maintenance', 'offline') THEN
    NEW.maintenance_reason := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER bikes_clear_stale_maintenance_reason
  BEFORE INSERT OR UPDATE OF status, maintenance_reason ON bikes
  FOR EACH ROW EXECUTE FUNCTION bikes_clear_stale_maintenance_reason();
--> statement-breakpoint
UPDATE bikes SET maintenance_reason = NULL
  WHERE maintenance_reason IS NOT NULL AND status NOT IN ('maintenance', 'offline');

// Merging the two possible sources of an active ride's track:
//   - the bike's onboard GPS/IoT tracker (authoritative — keeps reporting even
//     when the rider's phone screen is locked and browser geolocation stops);
//   - the rider's phone (browser watchPosition, relayed via /api/rides/:id/point).
//
// The phone is only a fallback: it pauses whenever the screen locks or the tab
// backgrounds, which is exactly what leaves gaps in the saved route. When the
// bike tracker is reporting we treat it as the source of truth; otherwise we
// fall back to the phone track so there is no regression for bikes whose
// tracker is offline/absent.
//
// A point is [x, y, t] in the same abstract map space used everywhere else
// (see shared/geo.ts realToMap/mapToReal), so merged output drops straight into
// the existing rendering/segmentation pipeline (segmentTrack + Douglas-Peucker
// + Catmull-Rom) without conversion.
export type TrackPoint = [number, number, number];

export type TrackSource = "tracker" | "phone";

export interface MergedTrack {
  source: TrackSource;
  points: TrackPoint[];
}

// A tracker window needs at least two points to draw a line; a single ping is
// not enough to be authoritative, so we fall back to the phone track then.
const MIN_TRACKER_POINTS = 2;

// Default densification step. Bike trackers typically report on a fixed cadence
// (e.g. every 20-60s); linearly interpolating intermediate samples before
// smoothing keeps the line from looking like straight chords between sparse
// pings. Kept well below TRACK_GAP_MS so we never bridge a real reporting gap.
export const TRACKER_INTERP_STEP_MS = 10_000;

// Gaps larger than this are treated as genuine loss of signal and left intact
// so the downstream segmentTrack() can break the line instead of drawing a
// false straight segment across the missing stretch. Mirrors geoSmoothing's
// TRACK_GAP_MS; passed explicitly so this module stays free of client imports.
export const TRACKER_MAX_INTERP_GAP_MS = 45_000;

/**
 * Decide which source is authoritative for a ride window. Tracker wins whenever
 * it has enough points to form a line; otherwise the phone track is used.
 */
export function chooseTrackSource(tracker: TrackPoint[], phone: TrackPoint[]): MergedTrack {
  if (tracker.length >= MIN_TRACKER_POINTS) {
    return { source: "tracker", points: tracker };
  }
  return { source: "phone", points: phone };
}

/**
 * Insert linearly-interpolated points between consecutive samples whose spacing
 * exceeds `stepMs` but is still within `maxGapMs` (a continuous-but-sparse
 * stretch). Pairs spaced beyond `maxGapMs` are left untouched so a real signal
 * gap survives to segmentTrack(). Input must be time-ordered.
 */
export function interpolateSparse(
  points: TrackPoint[],
  stepMs: number = TRACKER_INTERP_STEP_MS,
  maxGapMs: number = TRACKER_MAX_INTERP_GAP_MS,
): TrackPoint[] {
  if (points.length < 2 || stepMs <= 0) return points.slice();
  const out: TrackPoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0, t0] = points[i];
    const [x1, y1, t1] = points[i + 1];
    out.push(points[i]);
    const dt = t1 - t0;
    if (dt <= stepMs || dt > maxGapMs) continue; // dense enough, or a real gap
    const steps = Math.floor(dt / stepMs);
    for (let s = 1; s < steps; s++) {
      const f = (s * stepMs) / dt;
      out.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, Math.round(t0 + dt * f)]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Full merge used by the active-ride track endpoint/poller: pick the
 * authoritative source, and densify sparse tracker output before it reaches the
 * smoothing pipeline. The phone track is passed through untouched (it is already
 * throttled/de-jittered on the client and segmented downstream).
 */
export function mergeRideTrack(opts: {
  tracker: TrackPoint[];
  phone: TrackPoint[];
  stepMs?: number;
  maxGapMs?: number;
}): MergedTrack {
  const chosen = chooseTrackSource(opts.tracker, opts.phone);
  if (chosen.source !== "tracker") return chosen;
  return {
    source: "tracker",
    points: interpolateSparse(chosen.points, opts.stepMs, opts.maxGapMs),
  };
}

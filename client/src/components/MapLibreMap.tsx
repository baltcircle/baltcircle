import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MapObject, Parking, Ride } from "@shared/schema";
import { REAL_CENTER } from "@shared/geo";

interface MapLibreMapProps {
  parkings?: Parking[];
  mapObjects?: MapObject[];
  ride?: Ride | null;
  height?: string;
  showLabels?: boolean;
  center?: [number, number] | null;
  className?: string;
}

// MapLibre GL style — vector tiles proxied through our Express /tiles/* route
const buildStyle = (): maplibregl.StyleSpecification => ({
  version: 8,
  sources: {
    kaliningrad: {
      type: "vector",
      url: "/tiles/data/kaliningrad.json",
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#e8f0f7" },
    },
    {
      id: "water",
      type: "fill",
      source: "kaliningrad",
      "source-layer": "water",
      paint: { "fill-color": "#a8d5e8" },
    },
    {
      id: "waterway",
      type: "line",
      source: "kaliningrad",
      "source-layer": "waterway",
      paint: { "line-color": "#a8d5e8", "line-width": 1 },
    },
    {
      id: "landuse",
      type: "fill",
      source: "kaliningrad",
      "source-layer": "landuse",
      paint: {
        "fill-color": [
          "match",
          ["get", "class"],
          "park",        "#c8e6c9",
          "wood",        "#b5d5a0",
          "grass",       "#d4edda",
          "residential", "#f5f0eb",
          "#ede8e0",
        ] as any,
      },
    },
    {
      id: "road-fill",
      type: "line",
      source: "kaliningrad",
      "source-layer": "transportation",
      filter: ["match", ["get", "class"],
        ["motorway","trunk","primary","secondary","tertiary","minor","service"], true, false] as any,
      paint: {
        "line-color": "#ffffff",
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          10, 1, 14, 4, 17, 10,
        ] as any,
      },
    },
    {
      id: "road-case",
      type: "line",
      source: "kaliningrad",
      "source-layer": "transportation",
      filter: ["match", ["get", "class"],
        ["motorway","trunk","primary","secondary"], true, false] as any,
      paint: {
        "line-color": "#d4c9bb",
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          10, 2, 14, 6, 17, 14,
        ] as any,
      },
    },
    {
      id: "building",
      type: "fill",
      source: "kaliningrad",
      "source-layer": "building",
      minzoom: 14,
      paint: {
        "fill-color": "#ddd6cc",
        "fill-outline-color": "#c9c0b5",
      },
    },
  ],
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
});

// Default center: Kaliningrad [lng, lat] as MapLibre expects
const DEFAULT_CENTER: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]];

export function MapLibreMap({
  parkings = [],
  mapObjects = [],
  ride,
  height = "100%",
  showLabels = false,
  center,
  className,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Track whether we already attempted init (prevents double-init on ResizeObserver fire)
  const initStartedRef = useRef(false);

  // ── Init map ──────────────────────────────────────────────────────────────
  // Problem with the old approach:
  //   • Map was initialized unconditionally in useEffect, regardless of whether
  //     the container had real pixel dimensions. When the wrapper has
  //     display:contents, the container is adopted by a grandparent and may
  //     report 0×0 at the time React first runs the effect.
  //   • map.resize() on "load" does NOT fix a 0×0 WebGL canvas — the canvas
  //     was already created at 0×0 size and MapLibre doesn't recreate it.
  //
  // Fix:
  //   1. Attach a ResizeObserver immediately on mount.
  //   2. When the observer fires with a non-zero size, initialize the map.
  //   3. After that, keep the observer alive so map.resize() stays in sync.
  //   4. No cleanup (map.remove()) — MapPage is always mounted as an overlay.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const tryInit = () => {
      // Already initialised — nothing to do
      if (mapRef.current) return;
      // Guard against double-init race from observer firing multiple times
      if (initStartedRef.current) return;

      // Check WebGL support first
      if (!maplibregl.supported()) {
        el.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-family:sans-serif">WebGL не поддерживается браузером</div>';
        return;
      }

      // Container must have real dimensions — if still 0×0, wait for next observer tick
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      initStartedRef.current = true;

      const map = new maplibregl.Map({
        container: el,
        style: buildStyle(),
        center: DEFAULT_CENTER,
        zoom: 11,
        attributionControl: false,
        // Prevent MapLibre from clamping canvas to an artificially small size
        // when the container reports zero during init
        trackResize: true,
      });

      map.addControl(
        new maplibregl.AttributionControl({ compact: true }),
        "bottom-right"
      );

      // After tiles + style finish loading, force a resize to ensure the
      // WebGL viewport is flush with the container's current pixel size.
      map.once("load", () => {
        map.resize();
      });

      mapRef.current = map;
    };

    // Use ResizeObserver as the primary init trigger: it fires once the
    // container gets its first non-zero layout, which is exactly when we
    // want to create the map.
    const observer = new ResizeObserver(() => {
      if (!mapRef.current) {
        // Not yet initialised — try now
        tryInit();
      } else {
        // Already initialised — keep the canvas in sync
        mapRef.current.resize();
      }
    });

    observer.observe(el);

    // Also attempt an immediate init in case the container already has size
    // (e.g., on subsequent renders when the effect re-runs)
    tryInit();

    // Do NOT return a cleanup that calls map.remove():
    // MapPage is always mounted (display:contents / display:none overlay arch).
    // Destroying the map here would break every navigation away-and-back.
    return () => {
      observer.disconnect();
      // Map instance is intentionally kept alive.
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fly to user position ──────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({
      center: [center[1], center[0]],
      zoom: 14,
      duration: 1000,
    });
  }, [center]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height, width: "100%" }}
    />
  );
}

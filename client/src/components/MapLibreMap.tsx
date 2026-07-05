import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import type { MapObject, Parking, Ride } from "@shared/schema";
import { REAL_CENTER } from "@shared/geo";

// maplibre-gl is bundled by Vite, so its web-worker is emitted same-origin and
// loaded automatically — no CDN, no cross-origin Worker, no setWorkerUrl hacks.
// The pmtiles Protocol is registered once at module load below.
let __pmRegistered = false;
function ensurePMTilesProtocol() {
  if (__pmRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile.bind(protocol));
  __pmRegistered = true;
}

interface MapLibreMapProps {
  parkings?: Parking[];
  mapObjects?: MapObject[];
  ride?: Ride | null;
  height?: string;
  showLabels?: boolean;
  center?: [number, number] | null;
  className?: string;
}

// NOTE: Kaliningrad oblast contour and land-mask hack removed in Protomaps migration.
// Protomaps has a real `earth` land layer — no synthetic mask needed.

const MAX_BOUNDS: [number, number, number, number] = [18.3, 53.2, 26.8, 57.3];

// PALETTE - swap any value by HEX to re-theme the whole map.
// Base tones follow the official Protomaps "light" flavor, tuned to the
// TakeRide brand (#1D1E5D dark / #61B5C4 light).
const COLORS = {
  land:            "#e8e6e1", // land polygon (Protomaps `earth` layer) — soft warm grey
  water:           "#61B5C4", // sea, gulfs, lakes, rivers — TakeRide brand light
  forest:          "#c4e7d2", // forest / wood (Protomaps light landcover.forest)
  grass:           "#d2efcf", // grass / meadow / park (landcover.grassland)
  farmland:        "#d8efd2", // farmland (landcover.farmland)
  urban:           "#e6e6e6", // urban_area / residential
  boundaryCountry: "#8a6fae", // RU / LT / PL state border (boundaries kind=country)
  boundaryRegion:  "#9a86b8", // oblast / region border (boundaries kind=region/county)
} as const;

// PMTiles file served same-origin via Express (Range request support, no CORS).
const PMTILES_URL = "/kaliningrad.pmtiles";

const buildStyle = (tileSource: { type: "pmtiles"; url: string } | { type: "xyz"; url: string }, minzoom: number, maxzoom: number): object => {
  // Russian label with graceful fallback (Protomaps stores names in `name:ru` / `name` / `name:en`).
  const RU = ["coalesce", ["get", "name:ru"], ["get", "name"], ["get", "name:en"]];
  return {
    version: 8,
    glyphs: "/glyphs/{fontstack}/{range}.pbf",
    sources: {
      pm: tileSource.type === "pmtiles"
        ? { type: "vector", url: `pmtiles://${tileSource.url}`, minzoom, maxzoom }
        : { type: "vector", tiles: [tileSource.url], minzoom, maxzoom },
    },
    layers: [
      // Sea = background; the real `earth` land polygon (Protomaps) draws on top at every zoom.
      { id: "background", type: "background", paint: { "background-color": COLORS.water } },

      // ── LAND (earth) — root fix: real clipped land polygon, no more flooding ──
      { id: "earth", type: "fill", source: "pm", "source-layer": "earth", paint: { "fill-color": COLORS.land } },

      // ── LANDCOVER (natural cover, z0-7) ──────────────────────────────────────
      {
        id: "landcover", type: "fill", source: "pm", "source-layer": "landcover",
        paint: {
          "fill-color": ["match", ["get", "kind"],
            "farmland",   COLORS.farmland,
            "grassland",  COLORS.grass,
            "forest",     COLORS.forest,
            "scrub",      COLORS.grass,
            "urban_area", COLORS.urban,
            COLORS.grass,
          ],
          "fill-opacity": 0.8,
        },
      },

      // ── LANDUSE (z2+) ─────────────────────────────────────────────────────────
      {
        id: "landuse", type: "fill", source: "pm", "source-layer": "landuse", minzoom: 9,
        paint: {
          "fill-color": ["match", ["get", "kind"],
            "forest",        COLORS.forest,
            "wood",          COLORS.forest,
            "park",          COLORS.grass,
            "national_park", COLORS.grass,
            "nature_reserve",COLORS.grass,
            "grass",         COLORS.grass,
            "meadow",        COLORS.grass,
            "farmland",      COLORS.farmland,
            "allotments",    COLORS.farmland,
            "cemetery",      COLORS.grass,
            "military",      "#e4dccc",
            "industrial",    "#e4ddd0",
            "commercial",    "#ecebe4",
            "residential",   COLORS.urban,
            "hospital",      "#f0e2e2",
            "college",       "#eeece2",
            "university",    "#eeece2",
            "school",        "#eeece2",
            "kindergarten",  "#eeece2",
            "beach",         "#f3ecc8",
            "pedestrian",    COLORS.urban,
            COLORS.urban,
          ],
          "fill-opacity": 0.85,
        },
      },

      // ── WATER (lakes/rivers/lagoons — ocean stays as background) ──────────────
      {
        id: "water", type: "fill", source: "pm", "source-layer": "water",
        filter: ["!=", ["get", "kind"], "ocean"],
        paint: { "fill-color": COLORS.water },
      },
      {
        id: "water-line", type: "line", source: "pm", "source-layer": "water",
        filter: ["in", ["get", "kind"], ["literal", ["river", "stream", "canal"]]],
        paint: {
          "line-color": COLORS.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 12, 2.5, 14, 4],
        },
      },

      // ── ADMIN BOUNDARIES ──────────────────────────────────────────────────────
      {
        id: "boundary-region", type: "line", source: "pm", "source-layer": "boundaries",
        filter: ["in", ["get", "kind"], ["literal", ["region", "county"]]], minzoom: 6,
        paint: {
          "line-color": COLORS.boundaryRegion,
          "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 10, 1.6],
          "line-dasharray": [2, 2], "line-opacity": 0.7,
        },
      },
      {
        id: "boundary-country", type: "line", source: "pm", "source-layer": "boundaries",
        filter: ["==", ["get", "kind"], "country"],
        paint: {
          "line-color": COLORS.boundaryCountry,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.2, 9, 2.2, 12, 3],
          "line-dasharray": [3, 1.5], "line-opacity": 0.85,
        },
      },

      // ── ROADS — casing ────────────────────────────────────────────────────────
      {
        id: "road-hw-case", type: "line", source: "pm", "source-layer": "roads",
        filter: ["==", ["get", "kind"], "highway"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#e0993a", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.5, 12, 5, 14, 9] },
      },
      {
        id: "road-major-case", type: "line", source: "pm", "source-layer": "roads",
        filter: ["==", ["get", "kind"], "major_road"], minzoom: 8,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#d0bc86", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 12, 3, 14, 6] },
      },

      // ── ROADS — fill ──────────────────────────────────────────────────────────
      {
        id: "road-hw", type: "line", source: "pm", "source-layer": "roads",
        filter: ["==", ["get", "kind"], "highway"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffce55", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.8, 12, 3.5, 14, 7] },
      },
      {
        id: "road-major", type: "line", source: "pm", "source-layer": "roads",
        filter: ["==", ["get", "kind"], "major_road"], minzoom: 8,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 12, 2, 14, 4.5] },
      },
      {
        id: "road-minor", type: "line", source: "pm", "source-layer": "roads",
        filter: ["==", ["get", "kind"], "minor_road"], minzoom: 11,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 14, 2.5] },
      },
      {
        id: "road-path", type: "line", source: "pm", "source-layer": "roads",
        filter: ["==", ["get", "kind"], "path"], minzoom: 13,
        paint: { "line-color": "#e8e0d0", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 14, 1.2] },
      },
      {
        id: "road-rail", type: "line", source: "pm", "source-layer": "roads",
        filter: ["==", ["get", "kind"], "rail"], minzoom: 10,
        paint: { "line-color": "#bbb0a8", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 2], "line-dasharray": [2, 2] },
      },

      // ── BUILDINGS (z11+) ──────────────────────────────────────────────────────
      {
        id: "building", type: "fill", source: "pm", "source-layer": "buildings", minzoom: 13,
        paint: {
          "fill-color": "#dcd5cb",
          "fill-outline-color": "#c6bdb3",
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 14, 0.9],
        },
      },

      // ── ROAD NAMES ────────────────────────────────────────────────────────────
      {
        id: "road-labels", type: "symbol", source: "pm", "source-layer": "roads", minzoom: 12,
        filter: ["in", ["get", "kind"], ["literal", ["highway", "major_road", "medium_road", "minor_road"]]],
        layout: {
          "text-field": RU,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 14, 12],
          "symbol-placement": "line",
          "text-max-angle": 30,
          "text-padding": 5,
        },
        paint: { "text-color": "#5a4a3a", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
      },

      // ── WATER NAMES ───────────────────────────────────────────────────────────
      {
        id: "water-labels", type: "symbol", source: "pm", "source-layer": "water", minzoom: 9,
        filter: ["has", "name"],
        layout: {
          "text-field": RU,
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "symbol-placement": "point",
        },
        paint: { "text-color": "#3a7ab0", "text-halo-color": "rgba(255,255,255,0.8)", "text-halo-width": 1.5 },
      },

      // ── PLACE LABELS ──────────────────────────────────────────────────────────
      {
        id: "place-labels", type: "symbol", source: "pm", "source-layer": "places",
        filter: ["in", ["get", "kind"], ["literal", ["locality", "city", "town", "village", "neighbourhood", "suburb"]]],
        layout: {
          "text-field": RU,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"],
            6,  ["match", ["get", "kind"], "city", 14, "town", 11, 9],
            12, ["match", ["get", "kind"], "city", 20, "town", 15, 12],
          ],
          "text-max-width": 8,
          "text-anchor": "center",
          "text-padding": 3,
          "symbol-sort-key": ["-", ["coalesce", ["get", "population_rank"], 0]],
        },
        paint: { "text-color": "#2d3a4a", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
      },
    ],
  };
};

const DEFAULT_CENTER: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]];

// ── COMPONENT ─────────────────────────────────────────────────────────────────
export function MapLibreMap({
  parkings = [], mapObjects = [], ride, height = "100%",
  showLabels = false, center, className,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<any>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;

    const initMap = (
      tileSource: { type: "pmtiles"; url: string } | { type: "xyz"; url: string },
      minzoom: number,
      maxzoom: number
    ) => {
      if (cancelled || mapRef.current) return;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return; // wait for a real size (ResizeObserver retries)
      const map = new maplibregl.Map({
        container: el,
        style: buildStyle(tileSource, minzoom, maxzoom) as any,
        center: DEFAULT_CENTER,
        zoom: 10,
        maxBounds: MAX_BOUNDS,
        attributionControl: false,
        trackResize: true,
      });
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      map.once("load", () => map.resize());
      mapRef.current = map;
    };

    const initXYZ = async () => {
      if (cancelled || mapRef.current) return;
      const origin = window.location.origin;
      try {
        const j: any = await fetch(`${origin}/tiles/data/kaliningrad.json`).then(r => r.json());
        if (cancelled) return;
        const rawTiles: string[] = Array.isArray(j.tiles) ? j.tiles : [];
        const tileUrl = rawTiles.map((u: string) =>
          u.startsWith("http") ? u : `${origin}${u.startsWith("/") ? "" : "/"}${u}`
        )[0] ?? `${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf`;
        initMap({ type: "xyz", url: tileUrl }, j.minzoom ?? 0, j.maxzoom ?? 14);
      } catch {
        if (!cancelled) initMap({ type: "xyz", url: `${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf` }, 0, 14);
      }
    };

    // maplibre + pmtiles are bundled (Vite emits the worker same-origin), so we
    // just register the pmtiles protocol and build the map. No async loading, no
    // worker-URL race, no cross-origin Worker restriction. The `earth` layer is
    // rendered on top of the water background, fixing the ocean-flood bug.
    const boot = () => {
      if (cancelled || mapRef.current) return;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return; // ResizeObserver retries once sized
      ensurePMTilesProtocol();
      // If the pmtiles file is missing (e.g. first deploy before CI), fall back
      // to the legacy XYZ proxy. We optimistically try pmtiles first.
      try {
        initMap({ type: "pmtiles", url: PMTILES_URL }, 0, 14);
      } catch {
        void initXYZ();
      }
    };

    const ro = new ResizeObserver(() => {
      if (mapRef.current) mapRef.current.resize();
      else boot();
    });
    ro.observe(el);

    boot();

    return () => { cancelled = true; ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  return <div ref={containerRef} className={className} style={{ height }} />;
}
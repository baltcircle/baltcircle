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
  water:           "#9fc9e0", // sea, gulfs, lakes, rivers — muted blue
  forest:          "#c4e7d2", // forest / wood (Protomaps light landcover.forest)
  grass:           "#d2efcf", // grass / meadow / park (landcover.grassland)
  farmland:        "#d8efd2", // farmland (landcover.farmland)
  urban:           "#e6e6e6", // urban_area / residential
  boundaryCountry: "#8a6fae", // RU / LT / PL state border (boundaries kind=country)
  roadOutline:     "#1D1E5D", // ALL roads — 1px outline in dark-theme primary (hollow fill)
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
      // Static label anchor for Poland: the `places` country point for Polska sits
      // south of the map's maxBounds, so it never renders. This forces "ПОЛЬША"
      // into the visible area (just below Kaliningrad) on far zoom.
      "poland-label": {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: { name: "Польша" },
            geometry: { type: "Point", coordinates: [20.2, 54.0] },
          }],
        },
      },
      // Static anchor for Kaliningrad's far-zoom label. The tile `places` point
      // can't be repositioned, so the city is pinned here (shifted east of its
      // real coord) and excluded from the tile `country-labels` filter below.
      "kaliningrad-label": {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [{
            type: "Feature",
            properties: { name: "Калининград" },
            geometry: { type: "Point", coordinates: [20.95, 54.72] },
          }],
        },
      },
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
        // Protected-area kinds (national_park / nature_reserve / protected_area)
        // are excluded: on the Curonian Spit they render as one big green
        // rectangle over the real wood/sand/beach polygons underneath.
        // minzoom 7: landcover (green base) only ships z5-7, landuse detail ships
        // z7+. Starting landuse at z7 closes the z8 gap where the map turned white
        // (no landcover, no landuse — only grey earth + water).
        id: "landuse", type: "fill", source: "pm", "source-layer": "landuse", minzoom: 7,
        filter: ["!", ["in", ["get", "kind"], ["literal", ["national_park", "nature_reserve", "protected_area"]]]],
        paint: {
          "fill-color": ["match", ["get", "kind"],
            "forest",        COLORS.forest,
            "wood",          COLORS.forest,
            "park",          COLORS.grass,
            "grass",         COLORS.grass,
            "meadow",        COLORS.grass,
            "farmland",      COLORS.farmland,
            "allotments",    COLORS.farmland,
            "cemetery",      COLORS.grass,
            "military",      COLORS.land,
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
        // Protomaps stores rivers/canals as LineString inside the SAME `water`
        // source-layer. A fill layer would triangulate those lines into diagonal
        // wedges across land, so the fill must be constrained to real polygons.
        id: "water", type: "fill", source: "pm", "source-layer": "water",
        filter: ["all", ["==", ["geometry-type"], "Polygon"], ["!=", ["get", "kind"], "ocean"]],
        paint: { "fill-color": COLORS.water },
      },
      {
        id: "water-line", type: "line", source: "pm", "source-layer": "water",
        filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "kind"], ["literal", ["river", "stream", "canal"]]]],
        paint: {
          "line-color": COLORS.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 12, 2.5, 14, 4],
        },
      },

      // ── ADMIN BOUNDARIES ──────────────────────────────────────────────────────
      // Region/county dashed borders removed: they cluttered the whole map with
      // "district" outlines the user didn't want. Only the country border stays.
      {
        id: "boundary-country", type: "line", source: "pm", "source-layer": "boundaries",
        filter: ["==", ["get", "kind"], "country"],
        paint: {
          "line-color": COLORS.boundaryCountry,
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.2, 9, 2.2, 12, 3],
          "line-dasharray": [3, 1.5], "line-opacity": 0.85,
        },
      },

      // ── ROADS — hollow outline ────────────────────────────────────────────────
      // ALL roads (highway/major/minor/path) render as a hollow shape: a dark
      // outline (COLORS.roadOutline, the dark-theme primary) with a land-coloured
      // interior, so only a 1px border shows on each side. Collapsed into TWO
      // layers (outline + interior) driven by `kind` widths to minimise draw calls
      // vs. the previous per-class layers. minzoom 8: roads carry no country/admin
      // property to clip to the oblast, so gating at z8 keeps them out of the
      // far-zoom country-label view where they bled into Lithuania/Poland.
      //
      // ROAD_W = interior width by kind/zoom; the outline layer is ROAD_W + 2px
      // (1px border each side).
      // `zoom` must sit directly inside a top-level interpolate, so the outline
      // width is a separate interpolate (= inner width + 2px), not arithmetic.
      ...(() => {
        // Interior width by kind/zoom. Minor roads are clearly thinner than the
        // trunk network at every zoom (Google/Яндекс/2ГИС style hierarchy).
        const ROAD_W: any = ["interpolate", ["linear"], ["zoom"],
          8,  ["match", ["get", "kind"], "highway", 1.2, "major_road", 0.9, 0.4],
          12, ["match", ["get", "kind"], "highway", 4.5, "major_road", 3, "minor_road", 1, "path", 0.6, 1],
          14, ["match", ["get", "kind"], "highway", 8, "major_road", 5.5, "minor_road", 2, "path", 1, 2],
          16, ["match", ["get", "kind"], "highway", 12, "major_road", 8, "minor_road", 4, "path", 1.5, 3],
        ];
        // Outline = interior + ~2px border (own interpolate; zoom must be top-level).
        const ROAD_W_OUT: any = ["interpolate", ["linear"], ["zoom"],
          8,  ["match", ["get", "kind"], "highway", 3.2, "major_road", 2.9, 2.4],
          12, ["match", ["get", "kind"], "highway", 6.5, "major_road", 5, "minor_road", 2.6, "path", 2, 2.6],
          14, ["match", ["get", "kind"], "highway", 10, "major_road", 7.5, "minor_road", 3.6, "path", 2.4, 3.6],
          16, ["match", ["get", "kind"], "highway", 14, "major_road", 10, "minor_road", 5.6, "path", 3, 4.6],
        ];
        // Zoom-gated visibility (matches reference maps): trunk roads from z8,
        // minor roads only once the user zooms into a district (z13), paths z14.
        // Filtering out minor/path at low zoom also means far fewer features are
        // drawn on the oblast overview — lighter load.
        const ROAD_FILTER: any = ["any",
          ["in", ["get", "kind"], ["literal", ["highway", "major_road"]]],
          ["all", ["==", ["get", "kind"], "minor_road"], [">=", ["zoom"], 13]],
          ["all", ["==", ["get", "kind"], "path"], [">=", ["zoom"], 14]],
        ];
        // Semi-transparent dark outline so roads read softly (not heavy black
        // borders); fully opaque land-coloured interior keeps the road body crisp.
        const OUT_OPACITY = 0.28;
        return [
          {
            id: "road-outline", type: "line", source: "pm", "source-layer": "roads", minzoom: 8,
            filter: ROAD_FILTER,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": COLORS.roadOutline, "line-width": ROAD_W_OUT, "line-opacity": OUT_OPACITY },
          },
          {
            id: "road-inner", type: "line", source: "pm", "source-layer": "roads", minzoom: 8,
            filter: ROAD_FILTER,
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": COLORS.land, "line-width": ROAD_W },
          },
        ];
      })(),
      {
        // Only mainline rail (Яндекс-style): service tracks (spur/yard/siding/
        // crossover) are excluded so the map isn't overloaded with yard clutter.
        id: "road-rail", type: "line", source: "pm", "source-layer": "roads", minzoom: 10,
        filter: ["all", ["==", ["get", "kind"], "rail"], ["!", ["has", "service"]]],
        paint: {
          "line-color": COLORS.roadOutline,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 1.5],
          "line-dasharray": [2, 2],
          "line-opacity": 0.45,
        },
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

      // ── WATER NAMES (polygons: bays, lagoons, lakes) ──────────────────────────
      {
        id: "water-labels", type: "symbol", source: "pm", "source-layer": "water", minzoom: 9,
        filter: ["all", ["has", "name"], ["==", ["geometry-type"], "Polygon"]],
        layout: {
          "text-field": RU,
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "symbol-placement": "point",
        },
        paint: { "text-color": "#3a7ab0", "text-halo-color": "rgba(255,255,255,0.8)", "text-halo-width": 1.5 },
      },

      // ── RIVER NAMES (LineString: written along the river, appear with roads) ──
      // minzoom 12 matches road-labels so rivers no longer label too early, and
      // symbol-placement:line writes the name INTO the river channel, not on top.
      {
        id: "river-labels", type: "symbol", source: "pm", "source-layer": "water", minzoom: 12,
        filter: ["all", ["has", "name"], ["==", ["geometry-type"], "LineString"]],
        layout: {
          "text-field": RU,
          "text-font": ["Noto Sans Italic"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 14, 12],
          "symbol-placement": "line",
          "text-max-angle": 30,
          "text-padding": 5,
        },
        paint: { "text-color": "#3a7ab0", "text-halo-color": "rgba(255,255,255,0.8)", "text-halo-width": 1.5 },
      },

      // ── FAR-ZOOM LABELS (z<8): border countries + Kaliningrad, BOLD ───────────
      // Neighbours Lithuania / Latvia / Poland (kind=country) plus the city of
      // Kaliningrad show while zoomed out. Kaliningrad is matched by its Russian
      // name because places store name=Калининград here (not the latin "Kaliningrad").
      // Cities appear from z8 via place-labels.
      {
        id: "country-labels", type: "symbol", source: "pm", "source-layer": "places",
        maxzoom: 8,
        // Poland and Kaliningrad are both rendered by static label layers below
        // (repositioned per design), so exclude them from the tile places here.
        filter: ["all", ["==", ["get", "kind"], "country"], ["!=", ["get", "name:ru"], "Польша"]],
        layout: {
          "text-field": RU,
          // Bold is not in the Protomaps font CDN (only Regular/Medium/Italic);
          // Medium is the heaviest available weight — used here for "жирный".
          "text-font": ["Noto Sans Medium"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 13, 7, 17],
          "text-max-width": 8,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.15,
          "text-padding": 4,
        },
        paint: { "text-color": "#4a5a6a", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.5 },
      },

      // ── POLAND STATIC LABEL (z<8): forced into visible area below Kaliningrad ──
      {
        id: "poland-label", type: "symbol", source: "poland-label",
        maxzoom: 8,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Medium"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 13, 7, 17],
          "text-transform": "uppercase",
          "text-letter-spacing": 0.15,
          "text-padding": 4,
        },
        paint: { "text-color": "#4a5a6a", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.5 },
      },

      // ── KALININGRAD STATIC LABEL (z<8): repositioned east of the city point ──
      {
        id: "kaliningrad-label", type: "symbol", source: "kaliningrad-label",
        maxzoom: 8,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Medium"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 4, 13, 7, 17],
          "text-max-width": 8,
          "text-transform": "uppercase",
          "text-letter-spacing": 0.15,
          "text-padding": 4,
        },
        paint: { "text-color": "#4a5a6a", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.5 },
      },

      // ── PLACE DOTS (z8+): small marker beside oblast town labels ───────────────
      // Oblast towns (Полесск, Гурьевск, Знаменск, …) all ship as kind=locality.
      // A dot + right-anchored label reads like the reference and lets more towns
      // fit before collision on the z8-9 overview.
      {
        id: "place-dots", type: "circle", source: "pm", "source-layer": "places", minzoom: 8,
        filter: ["in", ["get", "kind"], ["literal", ["locality", "city", "town", "village"]]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2, 11, 3],
          "circle-color": "#6b7280",
          "circle-stroke-color": "rgba(255,255,255,0.9)",
          "circle-stroke-width": 1,
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.9, 12, 0],
          "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.9, 12, 0],
        },
      },

      // ── PLACE LABELS (z8+): cities, towns, villages ───────────────────────────
      {
        id: "place-labels", type: "symbol", source: "pm", "source-layer": "places", minzoom: 8,
        filter: ["in", ["get", "kind"], ["literal", ["locality", "city", "town", "village", "neighbourhood", "suburb"]]],
        layout: {
          "text-field": RU,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"],
            8,  ["match", ["get", "kind"], "city", 15, "town", 12, 11],
            12, ["match", ["get", "kind"], "city", 20, "town", 15, 12],
          ],
          // Right-anchored so the text sits beside the dot at overview zoom, then
          // re-centres once the dot fades out (z12+).
          "text-anchor": ["step", ["zoom"], "left", 12, "center"],
          "text-offset": ["step", ["zoom"], ["literal", [0.5, 0]], 12, ["literal", [0, 0]]],
          "text-max-width": 8,
          "text-padding": 1.5,
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
import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import type { Bike, MapObject, Parking, Ride, Ticket } from "@shared/schema";
import { REAL_CENTER, mapToReal } from "@shared/geo";

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

/** Which optional overlay layers are drawn. Every flag defaults to visible so
 *  the customer map and editors are unaffected; the admin operations map flips
 *  these from its layer toggles. Mirrors the old YandexMap MapLayers contract. */
export interface MapLayers {
  parkings?: boolean;
  bikes?: boolean;
  rides?: boolean;
  tickets?: boolean;
  objects?: boolean;
}

interface MapLibreMapProps {
  parkings?: Parking[];
  mapObjects?: MapObject[];
  ride?: Ride | null;
  /** Fleet bikes drawn as coloured dots (admin operations map). */
  bikes?: Bike[];
  /** Active rides drawn as start markers + track lines (admin operations map). */
  activeRides?: Ride[];
  /** Open service tickets, drawn at their bike's position (admin operations map). */
  tickets?: Ticket[];
  /** Per-layer visibility. Omitted layers render as before (visible). */
  layers?: MapLayers;
  selectedBikeId?: string | null;
  onSelectBike?: (id: string) => void;
  onSelectParking?: (id: string) => void;
  onSelectRide?: (id: number) => void;
  onSelectTicket?: (id: number) => void;
  /** Disables map gestures when false (static preview). */
  interactive?: boolean;
  /** Map click returns [lat, lng] — enables the editor draw mode. */
  onMapClick?: (coords: [number, number]) => void;
  /** Receives a getter for the current map centre as [lat, lng] (editor). */
  onCenterGetter?: (getCenter: () => [number, number]) => void;
  height?: string;
  showLabels?: boolean;
  center?: [number, number] | null;
  className?: string;
}

// Overlay marker colours (resolved HEX — swap here to re-theme markers).
const MARKER_COLORS = {
  bikeAvailable:  "#26a884",
  bikeRented:     "#1d6f8e",
  bikeMaintenance:"#d64545",
  bikeReserved:   "#e0972a",
  bikeDefault:    "#8a8f96",
  parkingActive:  "#1d6f8e",
  parkingInactive:"#8a8f96",
  ride:           "#1d6f8e",
  ticketHigh:     "#d64545",
  ticketLow:      "#e0972a",
} as const;

function bikeMarkerColor(status: string): string {
  switch (status) {
    case "available":   return MARKER_COLORS.bikeAvailable;
    case "rented":      return MARKER_COLORS.bikeRented;
    case "maintenance": return MARKER_COLORS.bikeMaintenance;
    case "reserved":    return MARKER_COLORS.bikeReserved;
    default:            return MARKER_COLORS.bikeDefault;
  }
}

function ticketMarkerColor(priority: string): string {
  return priority === "critical" || priority === "high"
    ? MARKER_COLORS.ticketHigh
    : MARKER_COLORS.ticketLow;
}

/** Build a small circular DOM marker element (bikes/rides/tickets). */
function dotMarkerEl(color: string, opts: { ring?: boolean; size?: number; clickable?: boolean } = {}): HTMLDivElement {
  const size = opts.size ?? 16;
  const el = document.createElement("div");
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.borderRadius = "50%";
  el.style.background = color;
  el.style.border = opts.ring ? "3px solid #fff" : "2px solid #fff";
  el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.35)";
  el.style.boxSizing = "border-box";
  el.style.cursor = opts.clickable ? "pointer" : "default";
  return el;
}

/** Build a "P" parking marker element. */
function parkingMarkerEl(inactive: boolean, clickable: boolean): HTMLDivElement {
  const el = document.createElement("div");
  el.style.minWidth = "22px";
  el.style.height = "22px";
  el.style.padding = "0 4px";
  el.style.display = "flex";
  el.style.alignItems = "center";
  el.style.justifyContent = "center";
  el.style.borderRadius = "6px";
  el.style.background = inactive ? MARKER_COLORS.parkingInactive : MARKER_COLORS.parkingActive;
  el.style.color = "#fff";
  el.style.font = "600 12px/1 system-ui, sans-serif";
  el.style.border = "2px solid #fff";
  el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.35)";
  el.style.opacity = inactive ? "0.75" : "1";
  el.style.cursor = clickable ? "pointer" : "default";
  el.textContent = "P";
  el.title = inactive ? "Парковка · неактивна" : "Парковка";
  return el;
}

/** Fill colour for a saved zone polygon, derived from its stroke colour. */
function fillFromColor(color: string): string {
  return `${color}22`; // ~13% alpha
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
  urban:           "#dcdcec", // urban_area / residential / built-up landuse — light tint of brand #1D1E5D
  building:        "#cfd0e3", // building polygons — slightly deeper tint of brand #1D1E5D (reads over `urban`)
  boundaryCountry: "#8a6fae", // RU / LT / PL state border (boundaries kind=country)
  roadOutline:     "#1D1E5D", // ALL roads — 1px outline in dark-theme primary (hollow fill)
  houseNumber:     "#1D1E5D", // house-number labels (z16+) — brand blue, rendered at 0.55 opacity
} as const;

// PMTiles file served same-origin via Express (Range request support, no CORS).
const PMTILES_URL = "/kaliningrad.pmtiles";
const ADDR_URL = "/addresses.pmtiles";

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
      // House-number overlay — separate lightweight pmtiles (OSM addr:housenumber).
      // The base Protomaps extract carries no address data, so numbers ship as
      // their own source. Tiles are built z14-16; MapLibre overzooms past z16.
      addr: { type: "vector", url: `pmtiles://${ADDR_URL}`, minzoom: 14, maxzoom: 16 },
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
      // Operator-drawn routes/zones (from the visual map editor) + live ride
      // tracks. Populated at runtime via setData; empty at init.
      "saved-objects": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      "ride-tracks":   { type: "geojson", data: { type: "FeatureCollection", features: [] } },
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
            "industrial",    COLORS.urban,
            "commercial",    COLORS.urban,
            "residential",   COLORS.urban,
            "hospital",      "#f0e2e2",
            "college",       COLORS.urban,
            "university",    COLORS.urban,
            "school",        COLORS.urban,
            "kindergarten",  COLORS.urban,
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
        filter: ["all", ["==", ["get", "kind"], "rail"], ["!", ["has", "service"]], ["!=", ["get", "kind_detail"], "tram"], ["!=", ["get", "kind_detail"], "light_rail"]],
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
          "fill-color": COLORS.building,
          "fill-outline-color": COLORS.building,
          // Opaque at z14+ so underlying road lines don't bleed through the building.
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.7, 14, 1],
        },
      },

      // ── HOUSE NUMBERS (z15+) ──────────────────────────────────────────────────
      // Overlay from the `addresses` pmtiles. Kept off until z15 (individual houses
      // become distinguishable there) so numbers don't clutter the map. Blue at 0.55
      // opacity; collision detection hides overlapping numbers automatically.
      {
        id: "house-numbers", type: "symbol", source: "addr", "source-layer": "addresses", minzoom: 15,
        layout: {
          "text-field": ["get", "hn"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 10, 18, 12],
          "text-allow-overlap": false,
          "text-padding": 4,
        },
        paint: {
          "text-color": COLORS.houseNumber,
          "text-opacity": ["interpolate", ["linear"], ["zoom"], 14.8, 0, 15.2, 0.55],
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
        paint: { "text-color": COLORS.roadOutline },
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

      // ── PLACE LABELS (z8+): cities, towns, villages ───────────────────────────
      // ── OPERATOR OBJECTS (routes/zones) + RIDE TRACKS ─────────────────────────
      // GeoJSON overlays drawn above the base map. Zone fills sit lowest, then
      // zone/route outlines, then ride tracks. Colours come per-feature from the
      // saved object's `color` (data-driven).
      {
        id: "saved-zone-fill", type: "fill", source: "saved-objects",
        filter: ["==", ["get", "kind"], "zone"],
        paint: { "fill-color": ["get", "fillColor"], "fill-opacity": 1 },
      },
      {
        id: "saved-zone-line", type: "line", source: "saved-objects",
        filter: ["==", ["get", "kind"], "zone"],
        layout: { "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 2 },
      },
      {
        id: "saved-route-line", type: "line", source: "saved-objects",
        filter: ["==", ["get", "kind"], "route"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 5, "line-opacity": 0.95 },
      },
      {
        id: "ride-track-line", type: "line", source: "ride-tracks",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": MARKER_COLORS.ride, "line-width": 4, "line-opacity": 0.9 },
      },

      {
        id: "place-labels", type: "symbol", source: "pm", "source-layer": "places", minzoom: 8,
        filter: ["in", ["get", "kind"], ["literal", ["locality", "city", "town", "village", "neighbourhood", "suburb"]]],
        layout: {
          "text-field": RU,
          "text-font": ["Noto Sans Regular"],
          // Base size by kind, with a +bump for five key towns. The bump is
          // applied INSIDE each interpolate stop's output (multiplying the base
          // by the town factor) so that ["zoom"] stays the direct top-level input
          // of interpolate (MapLibre requires this for text-size/line-width).
          "text-size": ["interpolate", ["linear"], ["zoom"],
            8,  ["*",
              ["match", ["get", "kind"], "city", 15, "town", 12, 11],
              ["match", RU, ["Калининград", "Пионерский", "Зеленоградск", "Светлогорск", "Янтарный"], 1.25, 1]],
            12, ["*",
              ["match", ["get", "kind"], "city", 20, "town", 15, 12],
              ["match", RU, ["Калининград", "Пионерский", "Зеленоградск", "Светлогорск", "Янтарный"], 1.25, 1]],
          ],
          "text-anchor": "center",
          "text-offset": ["literal", [0, 0]],
          "text-max-width": 8,
          "text-padding": 1.5,
          "symbol-sort-key": ["-", ["coalesce", ["get", "population_rank"], 0]],
        },
        paint: {
          "text-color": COLORS.roadOutline,
          // Opacity rules (Яндекс/Google-style), by kind:
          //  - Districts (neighbourhood/suburb): constant 0.55 — dimmer than
          //    street names, but always visible as in-city landmarks.
          //  - Towns/cities (population_rank >= 6: Калининград r10,
          //    Светлогорск/Зеленоградск/Пионерский/Гурьевск r6):
          //    FADE OUT by z13.5 so the settlement name doesn't clutter the
          //    street-level view once you're inside it.
          //  - Small settlements (villages, r<=5): stay visible at all zooms.
          // interpolate(zoom) must stay top-level; the per-feature branch is
          // nested inside each zoom stop's output.
          "text-opacity": ["interpolate", ["linear"], ["zoom"],
            12.5, ["match", ["get", "kind"], ["neighbourhood", "suburb"], 0.55, 1],
            13.5, [
              "case",
              ["in", ["get", "kind"], ["literal", ["neighbourhood", "suburb"]]], 0.55,
              [">=", ["coalesce", ["get", "population_rank"], 0], 6], 0,
              1,
            ],
          ],
        },
      },
    ],
  };
};

const DEFAULT_CENTER: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]];
const DEFAULT_ZOOM = 10;

// ── COMPONENT ─────────────────────────────────────────────────────────────────
export function MapLibreMap({
  parkings = [], mapObjects = [], ride = null,
  bikes = [], activeRides = [], tickets = [], layers = {},
  selectedBikeId, onSelectBike, onSelectParking, onSelectRide, onSelectTicket,
  interactive = true, onMapClick, onCenterGetter,
  height = "100%", showLabels = false, center, className,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<any>(null);
  // HTML markers (bikes/parkings/ride starts/tickets) are managed imperatively;
  // routes/zones/tracks go through GeoJSON sources. Kept in a ref so the render
  // effect can clear the previous batch before drawing the next.
  const markersRef   = useRef<any[]>([]);
  // Signals the overlay effects that the map instance + sources exist. Data that
  // resolves before map init would otherwise render into a null map and stay blank.
  const readyRef     = useRef(false);
  const [ready, setReady] = useState(false);

  // Latest callbacks kept in refs so the one-time init effect always calls the
  // current handler without re-subscribing map events on every render.
  const onMapClickRef      = useRef(onMapClick);      onMapClickRef.current = onMapClick;
  const onCenterGetterRef  = useRef(onCenterGetter);  onCenterGetterRef.current = onCenterGetter;
  const onSelectBikeRef    = useRef(onSelectBike);    onSelectBikeRef.current = onSelectBike;
  const onSelectParkingRef = useRef(onSelectParking); onSelectParkingRef.current = onSelectParking;
  const onSelectRideRef    = useRef(onSelectRide);    onSelectRideRef.current = onSelectRide;
  const onSelectTicketRef  = useRef(onSelectTicket);  onSelectTicketRef.current = onSelectTicket;

  // A layer renders unless its flag is explicitly false (default: visible).
  const show = {
    parkings: layers.parkings !== false,
    bikes:    layers.bikes    !== false,
    rides:    layers.rides    !== false,
    tickets:  layers.tickets  !== false,
    objects:  layers.objects  !== false,
  };

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
        center: center ? [center[1], center[0]] : DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        maxBounds: MAX_BOUNDS,
        attributionControl: false,
        trackResize: true,
        interactive,
      });
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      // Static previews (interactive=false): also hard-disable gestures so a
      // wrapping scroll container isn't hijacked by the map.
      if (!interactive) {
        map.scrollZoom.disable();
        map.dragPan.disable();
        map.doubleClickZoom.disable();
        map.touchZoomRotate.disable();
        map.keyboard.disable();
      }
      // Map clicks feed the editor draw mode with real [lat, lng].
      map.on("click", (e: any) => {
        onMapClickRef.current?.([e.lngLat.lat, e.lngLat.lng]);
      });
      map.once("load", () => {
        map.resize();
        readyRef.current = true;
        // Hand the editor a getter for the live centre as [lat, lng].
        onCenterGetterRef.current?.(() => {
          const c = map.getCenter();
          return [c.lat, c.lng] as [number, number];
        });
        if (!cancelled) setReady(true);
      });
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

    return () => {
      cancelled = true;
      ro.disconnect();
      readyRef.current = false;
      for (const m of markersRef.current) { try { m.remove(); } catch { /* ignore */ } }
      markersRef.current = [];
      try { mapRef.current?.remove(); } catch { /* ignore */ }
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  // ── HTML markers: parkings, bikes, active-ride starts, tickets ──────────────
  // Coordinate note: bikes/parkings are stored in abstract space; mapToReal(lng,lat)
  // returns real [lat, lng], and MapLibre markers take [lng, lat] — so we swap.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    for (const m of markersRef.current) { try { m.remove(); } catch { /* ignore */ } }
    markersRef.current = [];

    const addMarker = (lngLat: [number, number], el: HTMLElement, onClick?: () => void) => {
      if (interactive && onClick) el.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
      const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
      markersRef.current.push(marker);
    };

    // Parkings
    if (show.parkings) {
      for (const p of parkings) {
        const inactive = p.status === "inactive";
        const [lat, lng] = mapToReal(p.lng, p.lat);
        const el = parkingMarkerEl(inactive, interactive && !!onSelectParkingRef.current);
        el.title = inactive ? `${p.name} · неактивна` : p.name;
        addMarker([lng, lat], el, () => onSelectParkingRef.current?.(p.id));
      }
    }

    // Bikes
    if (show.bikes) {
      for (const b of bikes) {
        const isSel = b.id === selectedBikeId;
        const [lat, lng] = mapToReal(b.lng, b.lat);
        const el = dotMarkerEl(bikeMarkerColor(b.status), { ring: isSel, size: isSel ? 20 : 16, clickable: interactive && !!onSelectBikeRef.current });
        el.title = `${b.id} · ${b.model} · ${b.battery}%`;
        addMarker([lng, lat], el, () => onSelectBikeRef.current?.(b.id));
      }
    }

    // Active rides — start markers (tracks are drawn via the ride-tracks source).
    if (show.rides) {
      for (const r of activeRides) {
        const [lat, lng] = mapToReal(r.startLng, r.startLat);
        const el = dotMarkerEl(MARKER_COLORS.ride, { size: 14, clickable: interactive && !!onSelectRideRef.current });
        el.title = `Поездка #${r.id} · велосипед ${r.bikeId}`;
        addMarker([lng, lat], el, () => onSelectRideRef.current?.(r.id));
      }
    }

    // Open / high-priority tickets at their bike's position.
    if (show.tickets) {
      const bikeById = new Map(bikes.map((b) => [b.id, b] as const));
      for (const t of tickets) {
        const bike = bikeById.get(t.bikeId);
        if (!bike) continue;
        const [lat, lng] = mapToReal(bike.lng, bike.lat);
        const el = dotMarkerEl(ticketMarkerColor(t.priority), { size: 13, clickable: interactive && !!onSelectTicketRef.current });
        el.title = `Тикет #${t.id} · ${t.bikeId} · ${t.title || t.kind}`;
        addMarker([lng, lat], el, () => onSelectTicketRef.current?.(t.id));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bikes, parkings, activeRides, tickets, selectedBikeId, interactive,
      show.parkings, show.bikes, show.rides, show.tickets]);

  // ── GeoJSON overlays: operator objects (routes/zones) ───────────────────────
  // Editor points are already real [lat, lng]; GeoJSON needs [lng, lat].
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("saved-objects");
    if (!src) return;

    const features: any[] = [];
    if (show.objects) {
      for (const obj of mapObjects) {
        let pts: [number, number][];
        try { pts = JSON.parse(obj.points) as [number, number][]; } catch { continue; }
        if (!Array.isArray(pts) || pts.length < 2) continue;
        const ring = pts.map(([lat, lng]) => [lng, lat]);
        const props = { kind: obj.kind, color: obj.color, fillColor: fillFromColor(obj.color), name: obj.name };
        if (obj.kind === "zone") {
          const closed = [...ring];
          const [f0, f1] = closed[0]; const [l0, l1] = closed[closed.length - 1];
          if (f0 !== l0 || f1 !== l1) closed.push(closed[0]); // GeoJSON polygons must close
          features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [closed] } });
        } else {
          features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: ring } });
        }
      }
    }
    src.setData({ type: "FeatureCollection", features });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mapObjects, show.objects]);

  // ── GeoJSON overlays: ride tracks (customer single ride + admin active rides) ─
  // Track points are [[x, y, t], ...] in abstract space; mapToReal(x,y) → [lat,lng],
  // GeoJSON needs [lng, lat].
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("ride-tracks");
    if (!src) return;

    const features: any[] = [];
    const addTrack = (raw: string | null | undefined) => {
      if (!raw) return;
      let pts: [number, number, number][];
      try { pts = JSON.parse(raw) as [number, number, number][]; } catch { return; }
      const coords = pts.map(([x, y]) => { const [lat, lng] = mapToReal(x, y); return [lng, lat]; });
      if (coords.length > 1) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
    };
    if (show.rides) {
      if (ride) addTrack(ride.track);
      for (const r of activeRides) addTrack(r.track);
    }
    src.setData({ type: "FeatureCollection", features });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ride, activeRides, show.rides]);

  return <div ref={containerRef} className={className} style={{ height }} />;
}
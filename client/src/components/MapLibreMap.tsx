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
  /**
   * Live draft для редактора карты. Точки — [lat, lng]. Отрисуется как
   * полупрозрачная линия/полигон + вершины-маркеры с номерами. Клик по вершине
   * вызывает onVertexClick(index). Клик по первой вершине для zone удобно
   * трактовать как «замкнуть» на уровне вызывающего кода.
   */
  editorDraft?: {
    points: [number, number][];
    kind: "route" | "zone";
    color: string;
    onVertexClick?: (index: number) => void;
    /** Перетаскивание вершины. coords — [lat, lng]. */
    onVertexDrag?: (index: number, coords: [number, number]) => void;
  } | null;
  height?: string;
  showLabels?: boolean;
  center?: [number, number] | null;
  /**
   * Слежение за GPS-точкой в режиме активной аренды. Когда true —
   * карта автоматически выравнивается по user location при каждом GPS update.
   */
  followUser?: boolean;
  /**
   * Каллбэк на каждый GPS update. Используется внешними компонентами
   * (напр. трекер активной аренды) чтобы не дублировать watchPosition.
   */
  onUserLocation?: (lat: number, lng: number, headingDeg: number | null) => void;
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

// map_objects.points может прийти как array (после hydrate на сервере)
// или как JSON-строка (легаси-кэш / старые версии). Страхуемся.
function coercePoints(raw: unknown): [number, number][] {
  if (Array.isArray(raw)) return raw as [number, number][];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed as [number, number][] : [];
    } catch { return []; }
  }
  return [];
}

// Chaikin corner-cutting: каждый сегмент заменяется двумя точками (1/4 и 3/4),
// что сглаживает углы. Концы линии сохраняются. iterations=3 — оптимально
// для GPS-маршрутов (ветви 8x от исходных сегментов).
function chaikinSmooth(coords: number[][], iterations = 3): number[][] {
  if (coords.length < 3) return coords;
  let curr = coords.slice();
  for (let it = 0; it < iterations; it++) {
    const next: number[][] = [curr[0]];
    for (let i = 0; i < curr.length - 1; i++) {
      const [x0, y0] = curr[i];
      const [x1, y1] = curr[i + 1];
      next.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      next.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    next.push(curr[curr.length - 1]);
    curr = next;
  }
  return curr;
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
      // Live editor draft — pending line/polygon during drawing.
      "editor-draft":  { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      // Blue-dot: user's current GPS position. Populated at runtime via setData
      // when navigator.geolocation.watchPosition resolves. Empty at init so the
      // dot doesn't render on the null island before permission is granted.
      "user-location": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
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
        // Interior width by kind/zoom. Three-tier hierarchy per user request:
        //   1) highway (motorway/trunk) — областные подходы + окружная/кольцевая,
        //      НЕ трогаем, сохраняем прежние ширины.
        //   2) major_road (primary/secondary) — крупные проспекты внутри кольцевой
        //      (Московский, Ленинский, Советский, Победы, ...). Уменьшены.
        //   3) medium_road / minor_road / path — ещё меньше, самые тонкие.
        const ROAD_W: any = ["interpolate", ["linear"], ["zoom"],
          8,  ["match", ["get", "kind"], "highway", 1.2, "major_road", 0.55, 0.3],
          12, ["match", ["get", "kind"], "highway", 4.5, "major_road", 1.8, "medium_road", 0.7, "minor_road", 0.55, "path", 0.4, 0.55],
          14, ["match", ["get", "kind"], "highway", 8, "major_road", 3.2, "medium_road", 1.3, "minor_road", 1.1, "path", 0.7, 1.1],
          16, ["match", ["get", "kind"], "highway", 12, "major_road", 4.8, "medium_road", 2.4, "minor_road", 2, "path", 1.1, 2],
        ];
        // Outline = interior + ~2px border (own interpolate; zoom must be top-level).
        const ROAD_W_OUT: any = ["interpolate", ["linear"], ["zoom"],
          8,  ["match", ["get", "kind"], "highway", 3.2, "major_road", 2.55, 2.3],
          12, ["match", ["get", "kind"], "highway", 6.5, "major_road", 3.8, "medium_road", 2.3, "minor_road", 2.15, "path", 1.8, 2.15],
          14, ["match", ["get", "kind"], "highway", 10, "major_road", 5.2, "medium_road", 2.9, "minor_road", 2.7, "path", 2.1, 2.7],
          16, ["match", ["get", "kind"], "highway", 14, "major_road", 6.8, "medium_road", 4, "minor_road", 3.6, "path", 2.5, 3.6],
        ];
        // Zoom-gated visibility (matches reference maps): trunk roads from z8,
        // minor roads only once the user zooms into a district (z13), paths z14.
        // Filtering out minor/path at low zoom also means far fewer features are
        // drawn on the oblast overview — lighter load.
        const ROAD_FILTER: any = ["any",
          ["in", ["get", "kind"], ["literal", ["highway", "major_road"]]],
          ["all", ["==", ["get", "kind"], "medium_road"], [">=", ["zoom"], 12]],
          ["all", ["==", ["get", "kind"], "minor_road"], [">=", ["zoom"], 13]],
          ["all", ["==", ["get", "kind"], "path"], [">=", ["zoom"], 14]],
        ];
        // Outline только для highway (областные + окружная). Все остальные (major/medium/
        // minor/path) рисуем без контура — в цвет land, чтобы были белыми линиями
        // без тёмной обводки (убирает паутину).
        const OUT_OPACITY = 0.28;
        return [
          {
            id: "road-outline", type: "line", source: "pm", "source-layer": "roads", minzoom: 8,
            filter: ["all", ROAD_FILTER, ["==", ["get", "kind"], "highway"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": COLORS.roadOutline, "line-width": ROAD_W_OUT, "line-opacity": OUT_OPACITY },
          },
          {
            // highway — hollow в цвет land (внутри контура).
            id: "road-inner-highway", type: "line", source: "pm", "source-layer": "roads", minzoom: 8,
            filter: ["all", ROAD_FILTER, ["==", ["get", "kind"], "highway"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": COLORS.land, "line-width": ROAD_W },
          },
          {
            // major/medium/minor/path — без контура, светло-серые линии.
            id: "road-inner", type: "line", source: "pm", "source-layer": "roads", minzoom: 8,
            filter: ["all", ROAD_FILTER, ["!=", ["get", "kind"], "highway"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#c9c7c1", "line-width": ROAD_W },
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

      // ── EDITOR DRAFT (live drawing preview) ───────────────────────────────────
      // Полупрозрачная заливка для zone-черновика.
      {
        id: "editor-draft-fill", type: "fill", source: "editor-draft",
        filter: ["==", ["get", "kind"], "zone"],
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.15 },
      },
      // Пунктирная линия черновика (и для route, и для zone до замыкания).
      {
        id: "editor-draft-line", type: "line", source: "editor-draft",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": 3,
          "line-opacity": 0.9,
          "line-dasharray": [2, 2],
        },
      },

      // ── USER LOCATION (голубая точка в стиле Google/Apple Maps) ─────────────
      // Три слоя на одном GeoJSON Point: мягкая аура → белое кольцо → цветная точка.
      // Цвет центра — брендовый --primary #61B5C4 (голубой TakeRide).
      {
        id: "user-location-accuracy", type: "circle", source: "user-location",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 18, 14, 34, 18, 56],
          "circle-color": "#61B5C4",
          "circle-opacity": 0.18,
          "circle-stroke-width": 0,
          "circle-pitch-alignment": "map",
        },
      },
      // Стрелка направления. Рисуется МЕЖДУ аурой и белым кольцом — видна
      // только кончик, торчащий из-под точки (как на Apple/Google Maps).
      // Отображается только когда hasHeading=true (в стоячем положении GPS не даёт heading).
      {
        id: "user-location-heading", type: "symbol", source: "user-location",
        filter: ["==", ["get", "hasHeading"], true],
        layout: {
          "icon-image": "user-heading-arrow",
          "icon-rotate": ["get", "heading"],
          "icon-rotation-alignment": "map",
          "icon-pitch-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-anchor": "center",
          "icon-size": 1,
        },
      },
      {
        id: "user-location-halo", type: "circle", source: "user-location",
        paint: {
          "circle-radius": 13,
          "circle-color": "#ffffff",
          "circle-opacity": 1,
          "circle-stroke-width": 0,
        },
      },
      {
        id: "user-location-dot", type: "circle", source: "user-location",
        paint: {
          "circle-radius": 8,
          "circle-color": "#61B5C4",
          "circle-opacity": 1,
          "circle-stroke-width": 0,
        },
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

// REAL_CENTER (54.945, 20.275) сидит в Акватории севернее Аммониевой косы —
// при zoom=10 на портретном экране верхняя половина вьюа — открытое море,
// пользователь видит голубой фон. Сдвигаем центр в глубь побережья (район между
// Пионерским и Зеленоградском) и увеличиваем стартовый zoom, чтобы суша заполнила экран.
const DEFAULT_CENTER: [number, number] = [20.35, 54.87]; // (lng, lat)
const DEFAULT_ZOOM = 11;

// ── COMPONENT ─────────────────────────────────────────────────────────────────
export function MapLibreMap({
  parkings = [], mapObjects = [], ride = null,
  bikes = [], activeRides = [], tickets = [], layers = {},
  selectedBikeId, onSelectBike, onSelectParking, onSelectRide, onSelectTicket,
  interactive = true, onMapClick, onCenterGetter, followUser, onUserLocation,
  editorDraft = null,
  height = "100%", showLabels = false, center, className,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<any>(null);
  // HTML markers (bikes/parkings/ride starts/tickets) are managed imperatively;
  // routes/zones/tracks go through GeoJSON sources. Kept in a ref so the render
  // effect can clear the previous batch before drawing the next.
  const markersRef   = useRef<any[]>([]);
  // Editor draft vertices — отдельный пул, чтобы не дёргать основной слой
  // маркеров при каждом добавлении точки.
  const draftMarkersRef = useRef<any[]>([]);
  // Signals the overlay effects that the map instance + sources exist. Data that
  // resolves before map init would otherwise render into a null map and stay blank.
  const readyRef     = useRef(false);
  const [ready, setReady] = useState(false);

  // Latest callbacks kept in refs so the one-time init effect always calls the
  // current handler without re-subscribing map events on every render.
  const onMapClickRef      = useRef(onMapClick);      onMapClickRef.current = onMapClick;
  const onCenterGetterRef  = useRef(onCenterGetter);  onCenterGetterRef.current = onCenterGetter;
  const followUserRef      = useRef(followUser);      followUserRef.current      = followUser;
  const onUserLocationRef  = useRef(onUserLocation);  onUserLocationRef.current  = onUserLocation;
  // Кэш последней GPS-точки — нужен чтобы при включении followUser мгновенно
  // перелететь к точке, а не ждать следующего watchPosition tick (может быть 5-15 сек).
  const lastUserPosRef     = useRef<{ lng: number; lat: number } | null>(null);
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
        // Регистрируем иконку-стрелку для heading. Треугольник указывает вверх (0° = север),
        // MapLibre крутит его по icon-rotate. Центр icon = центр GPS-точки; кончик
        // торчит из-под белого кольца (r=13px), остальное скрыто под точкой.
        if (!map.hasImage("user-heading-arrow")) {
          const size = 40;
          const c = document.createElement("canvas");
          c.width = size; c.height = size;
          const ctx = c.getContext("2d")!;
          ctx.fillStyle = "#1f2937"; // тёмно-серый — читаемо на голубой ауре
          ctx.beginPath();
          ctx.moveTo(size / 2, 4);              // кончик вверху
          ctx.lineTo(size / 2 - 7, size / 2 + 4); // левый низ
          ctx.lineTo(size / 2 + 7, size / 2 + 4); // правый низ
          ctx.closePath();
          ctx.fill();
          const img = ctx.getImageData(0, 0, size, size);
          map.addImage("user-heading-arrow", { width: size, height: size, data: new Uint8Array(img.data.buffer) });
        }
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
      for (const m of draftMarkersRef.current) { try { m.remove(); } catch { /* ignore */ } }
      draftMarkersRef.current = [];
      try { mapRef.current?.remove(); } catch { /* ignore */ }
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  // ── GEOLOCATION: watchPosition → update "user-location" source ───────────────
  // Подписываемся один раз при mount (когда карта готова). Не требуем сразу —
  // карта всё ещё рендерится без точки, и как только браузер выдаст первую точку — она
  // появится. При deny/failure просто не рисуем — карта работает без неё.
  useEffect(() => {
    if (!ready) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const map = mapRef.current;
    if (!map) return;

    // heading от GPS приходит только когда юзер двигается (в стоячем положении = null/NaN).
    // Храним последнее валидное значение в локальной переменной — как только человек остановился,
    // стрелка продолжает смотреть в туже сторону, куда шёл, а не обнуляется.
    let lastHeading: number | null = null;

    const updateSource = (lng: number, lat: number, rawHeading: number | null) => {
      const src = map.getSource("user-location");
      if (!src) return;
      // GPS speed=0 даёт heading=NaN; принимаем только числовые валидные градусы.
      if (rawHeading !== null && Number.isFinite(rawHeading)) lastHeading = rawHeading;
      src.setData({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {
            hasHeading: lastHeading !== null,
            heading: lastHeading ?? 0,
          },
          geometry: { type: "Point", coordinates: [lng, lat] },
        }],
      });
      // Кэшируем последнюю точку для мгновенного центрования при включении followUser.
      lastUserPosRef.current = { lng, lat };
      // Слежение за пользователем — мягкий easeTo (а не flyTo, чтобы карта не дёргалась).
      if (followUserRef.current) {
        map.easeTo({ center: [lng, lat], duration: 800, essential: true });
      }
      // Публикуем координаты наверх — трекер активной аренды подпишется.
      onUserLocationRef.current?.(lat, lng, lastHeading);
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => updateSource(pos.coords.longitude, pos.coords.latitude, pos.coords.heading ?? null),
      () => { /* silent fail — no dot */ },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [ready]);

  // При включении followUser (начало аренды) — мгновенно летим к GPS-точке,
  // не дожидаясь следующего watchPosition tick.
  useEffect(() => {
    if (!ready) return;
    if (!followUser) return;
    const map = mapRef.current;
    if (!map) return;
    const p = lastUserPosRef.current;
    if (!p) return; // точка ещё не пришла — первый tick сам сцентрирует.
    map.flyTo({ center: [p.lng, p.lat], zoom: 15, duration: 800, essential: true });
  }, [followUser, ready]);

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
        // Тултип на маркере без заряда замка — клиенту эта информация не нужна.
        el.title = `${b.id} · ${b.model}`;
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
        const pts = coercePoints(obj.points);
        if (!Array.isArray(pts) || pts.length < 2) continue;
        const ring = pts.map(([lat, lng]) => [lng, lat]);
        const props = { kind: obj.kind, color: obj.color, fillColor: fillFromColor(obj.color), name: obj.name };
        if (obj.kind === "zone") {
          const closed = [...ring];
          const [f0, f1] = closed[0]; const [l0, l1] = closed[closed.length - 1];
          if (f0 !== l0 || f1 !== l1) closed.push(closed[0]); // GeoJSON polygons must close
          features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [closed] } });
        } else {
          // Маршрут сглаживаем в финальном превью (публичная карта и
          // черновик-геометрия в preview-блоке editor'а). Сами точки
          // в БД остаются исходными — если потом захочешь редактировать,
          // вершины грузятся без искажений.
          const smooth = obj.kind === "route" ? chaikinSmooth(ring, 3) : ring;
          features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: smooth } });
        }
      }
    }
    src.setData({ type: "FeatureCollection", features });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mapObjects, show.objects]);

  // ── EDITOR DRAFT: линия/полигон + вершины-маркеры ─────────────────────────
  // Точки в editorDraft хранятся как [lat, lng]; в GeoJSON идёт [lng, lat].
  // Линия/полигон рисуется через layer, вершины — через HTML-маркеры
  // (чтобы клик по ним был целью — так вызывающий код видит index вершины).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("editor-draft");
    if (!src) return;

    // 1) Линия/полигон
    const features: any[] = [];
    const pts = editorDraft?.points ?? [];
    const color = editorDraft?.color ?? "#1d6f8e";
    const kind = editorDraft?.kind ?? "route";
    if (pts.length >= 2) {
      const ring = pts.map(([lat, lng]) => [lng, lat]);
      if (kind === "zone" && pts.length >= 3) {
        const closed = [...ring, ring[0]];
        features.push({
          type: "Feature",
          properties: { kind: "zone", color },
          geometry: { type: "Polygon", coordinates: [closed] },
        });
      }
      features.push({
        type: "Feature",
        properties: { kind, color },
        geometry: { type: "LineString", coordinates: ring },
      });
    }
    src.setData({ type: "FeatureCollection", features });

    // 2) Вершины — HTML маркеры
    for (const m of draftMarkersRef.current) { try { m.remove(); } catch { /* ignore */ } }
    draftMarkersRef.current = [];

    if (pts.length === 0) return;

    const total = pts.length;
    const isZone = kind === "zone";
    pts.forEach((p, i) => {
      const [lat, lng] = p;
      const isFirst = i === 0;
      const isLast = i === total - 1;
      // Важно: MapLibre ставит transform на сам элемент маркера (translate
      // для позиционирования). Любые свои анимации/scale — только на вложенном child,
      // иначе keyframe перезапишет координатный transform и маркер уедет в (0,0).
      const wrap = document.createElement("div");
      wrap.style.pointerEvents = "auto";
      const el = document.createElement("div");
      wrap.appendChild(el);

      const size = isFirst ? 22 : 18;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.borderRadius = "50%";
      el.style.background = isFirst ? "#ffffff" : color;
      el.style.border = isFirst ? `3px solid ${color}` : "2px solid #ffffff";
      el.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
      el.style.boxSizing = "border-box";
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.font = "600 10px/1 system-ui, sans-serif";
      el.style.color = isFirst ? color : "#ffffff";
      el.style.cursor = editorDraft?.onVertexDrag ? "grab" : (editorDraft?.onVertexClick ? "pointer" : "default");
      // Номер вершины внутри кружка.
      el.textContent = isFirst && isZone ? "◎" : String(i + 1);
      if (isFirst && isZone && total >= 3) {
        wrap.title = "Кликни чтобы замкнуть зону";
        // Анимация только на child — она не сломает координатный transform маркера.
        el.style.animation = "editor-pulse 1.5s ease-in-out infinite";
        // Кликабельная область — когда первая точка готова к замыканию, делаем
        // крупнее через прозрачный hit-area, чтобы палец точно попадал (особенно на мобилах).
        el.style.outline = `12px solid transparent`;
        el.style.outlineOffset = `0px`;
      } else if (isFirst) {
        wrap.title = "Первая точка";
      } else if (isLast) {
        wrap.title = `Точка ${i + 1} · последняя`;
      } else {
        wrap.title = `Точка ${i + 1}`;
      }
      // Drag включаем только если вызывающий код подписался на onVertexDrag.
      const marker = new maplibregl.Marker({
        element: wrap,
        draggable: !!editorDraft?.onVertexDrag,
      }).setLngLat([lng, lat]).addTo(map);

      // Флаг чтобы click не срабатывал после перетаскивания.
      let dragged = false;
      if (editorDraft?.onVertexDrag) {
        marker.on("dragstart", () => {
          dragged = true;
          el.style.animation = "none";
          el.style.transform = "scale(1.1)";
        });
        // Live-обновление GeoJSON source во время перетаскивания: точка
        // не отрывается от линии/полигона. Важно: меняем ТОЛЬКО source,
        // без вызова onVertexDrag — иначе React пересоздаст маркеры
        // через useEffect и drag прервётся.
        marker.on("drag", () => {
          const ll = marker.getLngLat();
          const dragSrc = map.getSource("editor-draft") as maplibregl.GeoJSONSource | undefined;
          if (!dragSrc) return;
          // pts — из замыкания (текущий черновик); i — индекс этой вершины.
          const nextPts: [number, number][] = pts.map((pp, idx) =>
            idx === i ? [ll.lat, ll.lng] as [number, number] : pp,
          );
          const nextFeatures: any[] = [];
          if (nextPts.length >= 2) {
            const nextRing = nextPts.map(([la, ln]) => [ln, la]);
            if (kind === "zone" && nextPts.length >= 3) {
              nextFeatures.push({
                type: "Feature",
                properties: { kind: "zone", color },
                geometry: { type: "Polygon", coordinates: [[...nextRing, nextRing[0]]] },
              });
            }
            nextFeatures.push({
              type: "Feature",
              properties: { kind, color },
              geometry: { type: "LineString", coordinates: nextRing },
            });
          }
          dragSrc.setData({ type: "FeatureCollection", features: nextFeatures });
        });
        marker.on("dragend", () => {
          const ll = marker.getLngLat();
          el.style.transform = "";
          editorDraft.onVertexDrag!(i, [ll.lat, ll.lng]);
          // dragged флаг снимется через microtask в click-хандлере, но маркер всё равно будет
          // пересоздан useEffect'ом после апдейта points.
        });
      }

      if (editorDraft?.onVertexClick) {
        const handler = (ev: Event) => {
          ev.stopPropagation();
          if (dragged) { dragged = false; return; }
          editorDraft.onVertexClick!(i);
        };
        wrap.addEventListener("click", handler);
        wrap.addEventListener("touchend", handler, { passive: true });
      }

      draftMarkersRef.current.push(marker);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, editorDraft?.points, editorDraft?.kind, editorDraft?.color]);

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
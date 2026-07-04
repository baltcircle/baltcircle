import { useEffect, useRef } from "react";
import type { MapObject, Parking, Ride } from "@shared/schema";
import { REAL_CENTER } from "@shared/geo";

declare global {
  interface Window {
    maplibregl: any;
    pmtilesProtocol: any;
  }
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

// PALETTE - swap any value by HEX to re-theme the whole map
const COLORS = {
  land:            "#eef1e8", // land polygon (Protomaps `earth` layer)
  water:           "#9fc9e0", // sea, gulfs, lakes, rivers
  boundaryCountry: "#8a6fae", // RU / LT / PL state border (boundaries kind=country)
  boundaryRegion:  "#9a86b8", // oblast / region border (boundaries kind=region/county)
} as const;

// PMTiles URL — loaded from /pmtiles_url.txt (written by CI after generation)
// Fallback to old /tiles proxy if PMTiles not yet available
const PMTILES_CDN = "https://unpkg.com/pmtiles@3/dist/pmtiles.js";
// PMTiles file URL — updated by CI on each regeneration
// PMTiles served same-origin via Express (Range request support, no CORS issues)
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
            "farmland",   "#eae4d2",
            "grassland",  "#d4e8c4",
            "forest",     "#aecb96",
            "urban_area", "#e8e3da",
            "#e6dfcf",
          ],
          "fill-opacity": 0.7,
        },
      },

      // ── LANDUSE (z2+) ─────────────────────────────────────────────────────────
      {
        id: "landuse", type: "fill", source: "pm", "source-layer": "landuse", minzoom: 9,
        paint: {
          "fill-color": ["match", ["get", "kind"],
            "forest",        "#aecb96",
            "wood",          "#aecb96",
            "park",          "#bce4b4",
            "national_park", "#bce4b4",
            "nature_reserve","#bce4b4",
            "grass",         "#d4e8c4",
            "meadow",        "#d4e8c4",
            "farmland",      "#eae4d2",
            "allotments",    "#e6ddc4",
            "cemetery",      "#d0e4cc",
            "military",      "#e4d4c4",
            "industrial",    "#e4d8ca",
            "commercial",    "#f0e8d2",
            "residential",   "#ece7de",
            "hospital",      "#f0dede",
            "college",       "#f0ecda",
            "university",    "#f0ecda",
            "school",        "#f0ecda",
            "kindergarten",  "#f0ecda",
            "beach",         "#f3ecc8",
            "pedestrian",    "#ece7de",
            "#e8e3da",
          ],
          "fill-opacity": 0.75,
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

// ── CDN ───────────────────────────────────────────────────────────────────────
const DEFAULT_CENTER: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]];
const CDN_BASE      = "https://unpkg.com/maplibre-gl@4.7.1/dist";
const CDN_CSP_JS    = `${CDN_BASE}/maplibre-gl-csp.js`;
const CDN_WORKER_JS = `${CDN_BASE}/maplibre-gl-csp-worker.js`;
const CDN_CSS       = `${CDN_BASE}/maplibre-gl.css`;

function ensureCSS() {
  if (document.getElementById("maplibre-css")) return;
  const link = document.createElement("link");
  link.id = "maplibre-css"; link.rel = "stylesheet"; link.href = CDN_CSS;
  document.head.appendChild(link);
}

// The CSP maplibre build REQUIRES a worker URL before any Map is constructed.
// This must run regardless of how maplibregl got loaded (fresh script or an
// existing tag from a prior StrictMode mount), so it lives in its own
// idempotent async step keyed off a window flag.
async function ensureWorkerUrl(): Promise<void> {
  const w = window as any;
  if (w.__mlWorkerSet) return;
  let blobUrl: string | null = null;
  try {
    const resp = await fetch(CDN_WORKER_JS);
    const text = await resp.text();
    blobUrl = URL.createObjectURL(new Blob([text], { type: "application/javascript" }));
  } catch { blobUrl = null; }
  try {
    window.maplibregl.setWorkerUrl(blobUrl ?? CDN_WORKER_JS);
    w.__mlWorkerSet = true;
  } catch { /* setWorkerUrl unavailable */ }
}

function loadMaplibreScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.maplibregl?.Map) { resolve(); return; }
    const existing = document.getElementById("maplibre-js") as HTMLScriptElement | null;
    if (existing) {
      // Script already in DOM (e.g. React StrictMode double-mount). If it has
      // finished loading the 'load' event will never fire again — poll instead.
      const poll = window.setInterval(() => {
        if (window.maplibregl?.Map) { window.clearInterval(poll); resolve(); }
      }, 50);
      existing.addEventListener("load", () => { window.clearInterval(poll); resolve(); });
      existing.addEventListener("error", () => { window.clearInterval(poll); reject(new Error("script failed")); });
      window.setTimeout(() => { window.clearInterval(poll); if (!window.maplibregl?.Map) reject(new Error("maplibre load timeout")); }, 15000);
      return;
    }
    const s = document.createElement("script");
    s.id = "maplibre-js"; s.src = CDN_CSP_JS;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("CDN failed"));
    document.head.appendChild(s);
  });
}

async function loadMaplibre(): Promise<void> {
  await loadMaplibreScript();
  await ensureWorkerUrl();
}

/** Load pmtiles.js from CDN and register protocol with maplibregl */
function registerPMTilesProtocol(): void {
  if (window.pmtilesProtocol) return;
  const pmtiles = (window as any).pmtiles;
  if (!pmtiles) throw new Error("pmtiles not found on window");
  const protocol = new pmtiles.Protocol();
  window.maplibregl.addProtocol("pmtiles", protocol.tile.bind(protocol));
  window.pmtilesProtocol = protocol;
}

function loadPMTiles(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.pmtilesProtocol) { resolve(); return; }
    // Script already loaded (e.g. StrictMode double-mount) — just register.
    if ((window as any).pmtiles) { try { registerPMTilesProtocol(); resolve(); } catch (e) { reject(e); } return; }
    const existing = document.getElementById("pmtiles-js") as HTMLScriptElement | null;
    if (existing) {
      // Tag present but library not yet on window — the 'load' event may have
      // already fired, so poll for window.pmtiles instead of only listening.
      const poll = window.setInterval(() => {
        if ((window as any).pmtiles) {
          window.clearInterval(poll);
          try { registerPMTilesProtocol(); resolve(); } catch (e) { reject(e as Error); }
        }
      }, 50);
      existing.addEventListener("error", () => { window.clearInterval(poll); reject(new Error("pmtiles CDN failed")); });
      window.setTimeout(() => { window.clearInterval(poll); if (!(window as any).pmtiles) reject(new Error("pmtiles load timeout")); }, 15000);
      return;
    }
    const s = document.createElement("script");
    s.id = "pmtiles-js"; s.src = PMTILES_CDN;
    s.onload = () => { try { registerPMTilesProtocol(); resolve(); } catch (e) { reject(e); } };
    s.onerror = () => reject(new Error("pmtiles CDN failed"));
    document.head.appendChild(s);
  });
}

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
    ensureCSS();
    let cancelled = false;
    let booting = false;

    const initMap = (
      tileSource: { type: "pmtiles"; url: string } | { type: "xyz"; url: string },
      minzoom: number,
      maxzoom: number
    ) => {
      if (cancelled || mapRef.current) return;
      const ml = window.maplibregl;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return;
      const map = new ml.Map({
        container: el,
        style: buildStyle(tileSource, minzoom, maxzoom),
        center: DEFAULT_CENTER,
        zoom: 10,
        maxBounds: MAX_BOUNDS,
        attributionControl: false,
        trackResize: true,
      });
      map.addControl(new ml.AttributionControl({ compact: true }), "bottom-right");
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

    // Single guaranteed-order boot: maplibre script + worker URL MUST both be
    // ready before any `new Map()`. The CSP build's worker is required — if the
    // map is constructed before setWorkerUrl() runs, the default worker loads an
    // HTML SPA-fallback and dies with "Unexpected token '<'", leaving only the
    // water background painted. Both the initial call and the ResizeObserver
    // funnel through here; `booting`/`mapRef` guards make it idempotent.
    const boot = async () => {
      if (cancelled || mapRef.current || booting) return;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return; // wait for a real size (ResizeObserver retries)
      booting = true;
      try {
        await loadMaplibre();      // script + worker URL (order enforced inside)
        if (cancelled) return;
        await loadPMTiles();       // pmtiles protocol
        if (cancelled) return;
        initMap({ type: "pmtiles", url: PMTILES_URL }, 0, 14);
      } catch {
        if (!cancelled) await initXYZ();
      } finally {
        booting = false;
      }
    };

    const ro = new ResizeObserver(() => {
      if (mapRef.current) mapRef.current.resize();
      else void boot();
    });
    ro.observe(el);

    void boot();

    return () => { cancelled = true; ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  return <div ref={containerRef} className={className} style={{ height }} />;
}
import { useEffect, useRef } from "react";
import type { MapObject, Parking, Ride } from "@shared/schema";
import { REAL_CENTER } from "@shared/geo";

declare global {
  interface Window { maplibregl: any; }
}

interface MapLibreMapProps {
  parkings?: Parking[];
  mapObjects?: MapObject[]
  ride?: Ride | null;
  height?: string;
  showLabels?: boolean;
  center?: [number, number] | null;
  className?: string;
}

// Kaliningrad oblast approximate boundary polygon (GeoJSON coordinates)
// bbox: ~lng 19.5–22.9, lat 54.2–55.35
const KALININGRAD_BOUNDARY = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      geometry: {
        type: "Polygon" as const,
        coordinates: [[
          [19.5, 54.2],
          [22.9, 54.2],
          [22.9, 55.35],
          [19.5, 55.35],
          [19.5, 54.2],
        ]],
      },
      properties: {},
    },
  ],
};

// maxBounds: slightly larger than oblast bbox so user can't scroll far outside
// Format: [west, south, east, north]
const MAX_BOUNDS: [number, number, number, number] = [18.8, 53.8, 23.6, 55.8];

const buildStyle = (tileUrl: string, minzoom: number, maxzoom: number): object => ({
  version: 8,
  // Glyphs proxied via same-origin /glyphs/ → protomaps CDN, avoids iOS WKWebView CORS issues
  glyphs: "/glyphs/{fontstack}/{range}.pbf",
  sources: {
    kaliningrad: { type: "vector", tiles: [tileUrl], minzoom, maxzoom },
    // GeoJSON boundary outline of Kaliningrad oblast
    "kaliningrad-boundary": {
      type: "geojson",
      data: KALININGRAD_BOUNDARY,
    },
  },
  layers: [
    // Background = water color so empty sea tiles (outside OSM extract bbox) look like ocean
    { id: "background", type: "background", paint: { "background-color": "#a8d5e8" } },
    // Landcover fills — farmland, grass, wood, wetland, sand
    // These cover the areas that look empty (fields, forests, meadows)
    {
      id: "landcover", type: "fill", source: "kaliningrad", "source-layer": "landcover",
      paint: {
        "fill-color": ["match", ["get", "class"],
          "farmland",  "#eee8d8",
          "grass",     "#d4edda",
          "wood",      "#b5d5a0",
          "wetland",   "#c8dfd0",
          "sand",      "#f0e8c8",
          "#e8e0d0"
        ],
        "fill-opacity": 0.85,
      },
    },
    {
      id: "water", type: "fill", source: "kaliningrad", "source-layer": "water",
      paint: { "fill-color": "#a8d5e8" },
    },
    {
      id: "waterway", type: "line", source: "kaliningrad", "source-layer": "waterway",
      paint: { "line-color": "#a8d5e8", "line-width": 1 },
    },
    {
      id: "landuse", type: "fill", source: "kaliningrad", "source-layer": "landuse",
      paint: {
        "fill-color": ["match", ["get", "class"],
          "park", "#c8e6c9", "wood", "#b5d5a0",
          "grass", "#d4edda", "residential", "#f5f0eb", "#ede8e0"],
      },
    },
    {
      id: "road-fill", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal",
        ["motorway","trunk","primary","secondary","tertiary","minor","service"]]],
      paint: { "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 4, 17, 10] },
    },
    {
      id: "road-case", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway","trunk","primary","secondary"]]],
      paint: { "line-color": "#d4c9bb",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 6, 17, 14] },
    },
    {
      id: "building", type: "fill", source: "kaliningrad", "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": "#ddd6cc", "fill-outline-color": "#c9c0b5" },
    },
    // City / town / village names — name:latin (only field available in tilemaker data)
    {
      id: "place-labels", type: "symbol", source: "kaliningrad", "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town", "village", "suburb", "hamlet"]]],
      layout: {
        "text-field": ["get", "name:latin"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"],
          7, ["match", ["get", "class"], ["city"], 14, ["town"], 12, 10],
          12, ["match", ["get", "class"], ["city"], 18, ["town"], 15, 12],
        ],
        "text-max-width": 8,
        "text-anchor": "center",
        "text-padding": 4,
        "symbol-sort-key": ["match", ["get", "class"], "city", 1, "town", 2, "village", 3, 4],
      },
      paint: {
        "text-color": "#2d3a4a",
        "text-halo-color": "rgba(255,255,255,0.85)",
        "text-halo-width": 1.5,
      },
    },
    // House numbers — visible from zoom 14 (max tile zoom)
    {
      id: "housenumber-labels", type: "symbol", source: "kaliningrad", "source-layer": "housenumber",
      minzoom: 14,
      layout: {
        "text-field": ["get", "housenumber"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-anchor": "center",
      },
      paint: {
        "text-color": "#7a6a55",
        "text-halo-color": "rgba(255,255,255,0.8)",
        "text-halo-width": 1,
      },
    },
    // Kaliningrad oblast boundary outline — dashed blue-grey line
    {
      id: "oblast-boundary",
      type: "line",
      source: "kaliningrad-boundary",
      paint: {
        "line-color": "#6a8caf",
        "line-width": 2,
        "line-dasharray": [4, 3],
        "line-opacity": 0.8,
      },
    },
  ],
});

const DEFAULT_CENTER: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]]; // [lng, lat]
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

// Fetch worker JS and create a same-origin blob URL.
// iOS WKWebView blocks Workers from cross-origin URLs (CDN),
// but allows blob: URLs created from fetched content.
async function makeWorkerBlobUrl(): Promise<string | null> {
  try {
    const resp = await fetch(CDN_WORKER_JS);
    const text = await resp.text();
    const blob = new Blob([text], { type: "application/javascript" });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function loadMaplibre(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.maplibregl?.Map) { resolve(); return; }
    const existing = document.getElementById("maplibre-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("script failed")));
      return;
    }
    const s = document.createElement("script");
    s.id = "maplibre-js"; s.src = CDN_CSP_JS;
    s.onload = () => {
      makeWorkerBlobUrl().then(blobUrl => {
        try {
          window.maplibregl.setWorkerUrl(blobUrl ?? CDN_WORKER_JS);
          resolve();
        } catch(e) { reject(e); }
      });
    };
    s.onerror = () => reject(new Error("CDN failed"));
    document.head.appendChild(s);
  });
}

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

    const initMap = (tileUrl: string, minzoom: number, maxzoom: number) => {
      if (cancelled || mapRef.current) return;
      const ml = window.maplibregl;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return;

      try {
        const map = new ml.Map({
          container: el, style: buildStyle(tileUrl, minzoom, maxzoom),
          center: DEFAULT_CENTER, zoom: 10,
          // Restrict panning: user can't scroll far outside Kaliningrad oblast
          maxBounds: MAX_BOUNDS,
          attributionControl: false, trackResize: true,
        });
        map.addControl(new ml.AttributionControl({ compact: true }), "bottom-right");
        map.once("load", () => map.resize());
        mapRef.current = map;
      } catch {
        // WebGL unavailable — map stays blank
      }
    };

    // Fetch TileJSON client-side and patch tiles[] to absolute URLs.
    // Bypasses server-side rewrite unreliability behind nginx proxy.
    const tryInit = () => {
      if (cancelled || mapRef.current) return;
      const ml = window.maplibregl;
      if (!ml?.Map) return;

      const origin = window.location.origin;
      fetch(`${origin}/tiles/data/kaliningrad.json`)
        .then(r => r.json())
        .then((j: any) => {
          if (cancelled) return;
          const rawTiles: string[] = Array.isArray(j.tiles) ? j.tiles : [];
          const tileUrl = rawTiles.map((u: string) =>
            u.startsWith("http") ? u : `${origin}${u.startsWith("/") ? "" : "/"}${u}`
          )[0] ?? `${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf`;
          initMap(tileUrl, j.minzoom ?? 0, j.maxzoom ?? 14);
        })
        .catch(() => {
          if (!cancelled)
            initMap(`${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf`, 0, 14);
        });
    };

    const ro = new ResizeObserver(() => {
      if (!mapRef.current) tryInit(); else mapRef.current.resize();
    });
    ro.observe(el);

    loadMaplibre()
      .then(() => { if (!cancelled) tryInit(); })
      .catch(() => { /* CDN unavailable */ });

    return () => { cancelled = true; ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  return (
    <div ref={containerRef} className={className} style={{ height }} />
  );
}

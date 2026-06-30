import { useEffect, useRef } from "react";
import type { MapObject, Parking, Ride } from "@shared/schema";
import { REAL_CENTER } from "@shared/geo";

declare global {
  interface Window { maplibregl: any; }
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

const buildStyle = (): object => ({
  version: 8,
  // No glyphs URL — we have zero symbol/text layers so fonts are never needed.
  // Including a glyphs URL (e.g. demotiles.maplibre.org) causes map.loaded()
  // to stay false indefinitely when that host is unreachable from the device.
  sources: {
    kaliningrad: { type: "vector", url: "/tiles/data/kaliningrad.json" },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#e8f0f7" } },
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
          "park",        "#c8e6c9",
          "wood",        "#b5d5a0",
          "grass",       "#d4edda",
          "residential", "#f5f0eb",
          "#ede8e0",
        ],
      },
    },
    {
      id: "road-fill", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal",
        ["motorway","trunk","primary","secondary","tertiary","minor","service"]]],
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 4, 17, 10],
      },
    },
    {
      id: "road-case", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal",
        ["motorway","trunk","primary","secondary"]]],
      paint: {
        "line-color": "#d4c9bb",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 6, 17, 14],
      },
    },
    {
      id: "building", type: "fill", source: "kaliningrad", "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": "#ddd6cc", "fill-outline-color": "#c9c0b5" },
    },
  ],
});

// MapLibre uses [lng, lat]; REAL_CENTER is [lat, lng]
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

function loadMaplibre(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.maplibregl?.Map) { resolve(); return; }
    const existing = document.getElementById("maplibre-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("CDN script failed")));
      return;
    }
    const script = document.createElement("script");
    script.id = "maplibre-js"; script.src = CDN_CSP_JS;
    script.onload = () => {
      try { window.maplibregl.setWorkerUrl(CDN_WORKER_JS); resolve(); }
      catch (e) { reject(e); }
    };
    script.onerror = () => reject(new Error("CDN load failed"));
    document.head.appendChild(script);
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

    const tryInit = () => {
      if (cancelled || mapRef.current) return;
      const ml = window.maplibregl;
      if (!ml?.Map) return;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return;

      try {
        const map = new ml.Map({
          container: el,
          style: buildStyle(),
          center: DEFAULT_CENTER,
          zoom: 11,
          attributionControl: false,
          trackResize: true,
        });
        map.addControl(new ml.AttributionControl({ compact: true }), "bottom-right");
        map.once("load", () => map.resize());
        mapRef.current = map;
      } catch (e) {
        console.error("[MapLibreMap] init failed:", e);
      }
    };

    const ro = new ResizeObserver(() => {
      if (!mapRef.current) tryInit();
      else mapRef.current.resize();
    });
    ro.observe(el);

    loadMaplibre()
      .then(() => { if (!cancelled) tryInit(); })
      .catch((e) => console.error("[MapLibreMap] CDN load failed:", e));

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

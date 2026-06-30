import { useEffect, useRef } from "react";
import type { MapObject, Parking, Ride } from "@shared/schema";
import { REAL_CENTER } from "@shared/geo";

declare global {
  interface Window {
    maplibregl: any;
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

const buildStyle = () => ({
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
          "match", ["get", "class"],
          "park",        "#c8e6c9",
          "wood",        "#b5d5a0",
          "grass",       "#d4edda",
          "residential", "#f5f0eb",
          "#ede8e0",
        ],
      },
    },
    {
      id: "road-fill",
      type: "line",
      source: "kaliningrad",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal",
        ["motorway","trunk","primary","secondary","tertiary","minor","service"]]],
      paint: {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"],
          10, 1, 14, 4, 17, 10],
      },
    },
    {
      id: "road-case",
      type: "line",
      source: "kaliningrad",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal",
        ["motorway","trunk","primary","secondary"]]],
      paint: {
        "line-color": "#d4c9bb",
        "line-width": ["interpolate", ["linear"], ["zoom"],
          10, 2, 14, 6, 17, 14],
      },
    },
    {
      id: "building",
      type: "fill",
      source: "kaliningrad",
      "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": "#ddd6cc", "fill-outline-color": "#c9c0b5" },
    },
  ],
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
});

// Default center: Kaliningrad [lng, lat]
const DEFAULT_CENTER: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]];

// Inject MapLibre CSS from CDN once, without polluting the Vite bundle
function ensureMaplibreCSS() {
  if (document.getElementById("maplibre-css")) return;
  const link = document.createElement("link");
  link.id = "maplibre-css";
  link.rel = "stylesheet";
  link.href = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";
  document.head.appendChild(link);
}

// Load MapLibre JS from CDN, call cb when ready
function loadMaplibre(cb: () => void) {
  if (window.maplibregl) { cb(); return; }
  const existing = document.getElementById("maplibre-js");
  if (existing) { existing.addEventListener("load", cb); return; }
  const script = document.createElement("script");
  script.id = "maplibre-js";
  script.src = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
  script.onload = cb;
  document.head.appendChild(script);
}

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
  const mapRef = useRef<any>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    ensureMaplibreCSS();

    // Init map — called once MapLibre is loaded AND container has real size
    const initMap = () => {
      if (mapRef.current) return; // already initialised
      const ml = window.maplibregl;
      if (!ml) return;

      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return; // wait for ResizeObserver

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
    };

    // ResizeObserver fires when container gets real dimensions
    const ro = new ResizeObserver(() => {
      if (!mapRef.current) {
        initMap();
      } else {
        mapRef.current.resize();
      }
    });
    ro.observe(el);

    // Load CDN script, then try to init
    loadMaplibre(initMap);

    return () => {
      ro.disconnect();
      // Do NOT call map.remove() — MapPage is always mounted as overlay
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fly to user geolocation
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
      style={{ height }}
    />
  );
}

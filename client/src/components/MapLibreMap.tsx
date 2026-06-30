import { useEffect, useRef, useCallback } from "react";
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

const TILE_URL = "http://localhost:8080/data/kaliningrad/{z}/{x}/{y}.pbf";
const TILEJSON_URL = "http://localhost:8080/data/kaliningrad.json";

// MapLibre style using our local vector tiles
const buildStyle = () => ({
  version: 8,
  sources: {
    "kaliningrad": {
      type: "vector",
      url: TILEJSON_URL,
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
          "park", "#c8e6c9",
          "wood", "#b5d5a0",
          "grass", "#d4edda",
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
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"]]],
      paint: {
        "line-color": "#ffffff",
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          10, 1,
          14, 4,
          17, 10,
        ],
      },
    },
    {
      id: "road-case",
      type: "line",
      source: "kaliningrad",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary"]]],
      paint: {
        "line-color": "#d4c9bb",
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          10, 2,
          14, 6,
          17, 14,
        ],
        "line-gap-width": 0,
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
  const initialCenter: [number, number] = center ?? [REAL_CENTER[1], REAL_CENTER[0]];

  const initMap = useCallback(() => {
    if (!containerRef.current || mapRef.current) return;
    const ml = window.maplibregl;
    if (!ml) return;

    const map = new ml.Map({
      container: containerRef.current,
      style: buildStyle(),
      center: initialCenter,
      zoom: 11,
      attributionControl: false,
    });

    map.addControl(new ml.AttributionControl({ compact: true }), "bottom-right");

    mapRef.current = map;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load MapLibre from CDN if not already loaded, then init
  useEffect(() => {
    if (window.maplibregl) {
      initMap();
      return;
    }

    const existingScript = document.getElementById("maplibre-js");
    if (existingScript) {
      existingScript.addEventListener("load", initMap);
      return () => existingScript.removeEventListener("load", initMap);
    }

    const script = document.createElement("script");
    script.id = "maplibre-js";
    script.src = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
    script.onload = initMap;
    document.head.appendChild(script);

    return () => {
      script.removeEventListener("load", initMap);
    };
  }, [initMap]);

  // Update center when prop changes
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height }}
    />
  );
}

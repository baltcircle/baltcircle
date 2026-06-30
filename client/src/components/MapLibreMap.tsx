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

  // Default center: Kaliningrad [lng, lat]
  const defaultCenter: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]];

  // Init map once container is mounted
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(),
      center: defaultCenter,
      zoom: 11,
      attributionControl: false,
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    // Ensure map fills container after first render (important when parent
    // starts hidden via display:none / display:contents toggle)
    map.once("load", () => {
      map.resize();
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fly to user position when center prop changes
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({
      center: [center[1], center[0]],
      zoom: 14,
      duration: 1000,
    });
  }, [center]);

  // Resize map when container visibility changes (overlay show/hide)
  useEffect(() => {
    if (!mapRef.current) return;
    const observer = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height, width: "100%" }}
    />
  );
}

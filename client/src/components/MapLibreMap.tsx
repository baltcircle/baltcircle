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
          "match", ["get", "class"],
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
        "line-width": ["interpolate", ["linear"], ["zoom"],
          10, 1, 14, 4, 17, 10] as any,
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
        "line-width": ["interpolate", ["linear"], ["zoom"],
          10, 2, 14, 6, 17, 14] as any,
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

// Default center: Kaliningrad. MapLibre uses [lng, lat] order.
const DEFAULT_CENTER: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]];

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // ── Init map ────────────────────────────────────────────────────────────
    // WHY ResizeObserver as trigger (not plain useEffect):
    //   App.tsx wraps MapPage in <div style="display:contents"> which removes
    //   the box from layout. At the time React runs this useEffect, the container
    //   may still be 0×0. MapLibre creates a WebGL canvas sized to the container
    //   at init time — a 0×0 canvas cannot be "resized" later by map.resize().
    //   Solution: observe the container and init the map on the FIRST tick where
    //   the container has real pixel dimensions.

    const initMap = () => {
      if (mapRef.current) return; // already initialised

      if (!maplibregl.supported()) {
        el.textContent = "WebGL не поддерживается браузером";
        return;
      }

      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return; // wait for next ResizeObserver tick

      const map = new maplibregl.Map({
        container: el,
        style: buildStyle(),
        center: DEFAULT_CENTER,
        zoom: 11,
        attributionControl: false,
        trackResize: true,
      });

      map.addControl(
        new maplibregl.AttributionControl({ compact: true }),
        "bottom-right",
      );

      map.once("load", () => map.resize());

      mapRef.current = map;
    };

    // Observe container size. Fires immediately with current size on attach,
    // and again whenever the container is resized or made visible.
    const ro = new ResizeObserver(() => {
      if (!mapRef.current) {
        initMap();
      } else {
        mapRef.current.resize();
      }
    });
    ro.observe(el);

    // Also try immediately (in case el already has size before observer fires)
    initMap();

    return () => {
      ro.disconnect();
      // !! Do NOT call map.remove() here !!
      // MapPage is always mounted (display:contents / display:none overlay).
      // Destroying the map would break navigation back to the home screen.
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fly to user geolocation ───────────────────────────────────────────────
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
      style={{ height, width: "100%" }}
    />
  );
}

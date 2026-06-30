import { useEffect, useRef, useState } from "react";
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
    { id: "background", type: "background", paint: { "background-color": "#e8f0f7" } },
    { id: "water", type: "fill", source: "kaliningrad", "source-layer": "water", paint: { "fill-color": "#a8d5e8" } },
    { id: "waterway", type: "line", source: "kaliningrad", "source-layer": "waterway", paint: { "line-color": "#a8d5e8", "line-width": 1 } },
    {
      id: "landuse", type: "fill", source: "kaliningrad", "source-layer": "landuse",
      paint: { "fill-color": ["match", ["get", "class"], "park", "#c8e6c9", "wood", "#b5d5a0", "grass", "#d4edda", "residential", "#f5f0eb", "#ede8e0"] },
    },
    {
      id: "road-fill", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway","trunk","primary","secondary","tertiary","minor","service"]]],
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 4, 17, 10] },
    },
    {
      id: "road-case", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["motorway","trunk","primary","secondary"]]],
      paint: { "line-color": "#d4c9bb", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 6, 17, 14] },
    },
    { id: "building", type: "fill", source: "kaliningrad", "source-layer": "building", minzoom: 14, paint: { "fill-color": "#ddd6cc", "fill-outline-color": "#c9c0b5" } },
  ],
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
});

const DEFAULT_CENTER: [number, number] = [REAL_CENTER[1], REAL_CENTER[0]];

function ensureMaplibreCSS() {
  if (document.getElementById("maplibre-css")) return;
  const link = document.createElement("link");
  link.id = "maplibre-css";
  link.rel = "stylesheet";
  link.href = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";
  document.head.appendChild(link);
}

function loadMaplibre(cb: (err?: string) => void) {
  if (window.maplibregl) { cb(); return; }
  const existing = document.getElementById("maplibre-js") as HTMLScriptElement | null;
  if (existing) {
    existing.addEventListener("load", () => cb());
    existing.addEventListener("error", () => cb("CDN script load error"));
    return;
  }
  const script = document.createElement("script");
  script.id = "maplibre-js";
  script.src = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
  script.onload = () => cb();
  script.onerror = () => cb("CDN script load error (unpkg.com blocked?)");
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

  // Diagnostic state — visible overlay in top-left corner
  const [diag, setDiag] = useState<string[]>(["⏳ init..."]);
  const addDiag = (msg: string) => setDiag(prev => [...prev.slice(-8), msg]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) { addDiag("❌ containerRef null"); return; }

    ensureMaplibreCSS();
    addDiag("📦 CSS injected");

    const initMap = (cdnErr?: string) => {
      if (cdnErr) { addDiag("❌ " + cdnErr); return; }
      if (mapRef.current) { addDiag("ℹ️ already init"); return; }

      addDiag("✅ CDN loaded");

      const ml = window.maplibregl;
      if (!ml) { addDiag("❌ window.maplibregl undefined"); return; }

      const rect = el.getBoundingClientRect();
      addDiag(`📐 ${Math.round(rect.width)}×${Math.round(rect.height)}`);

      if (rect.width === 0 || rect.height === 0) {
        addDiag("⏳ 0×0, waiting ResizeObserver...");
        return;
      }

      if (!ml.supported()) { addDiag("❌ WebGL not supported"); return; }

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

        map.on("error", (e: any) => {
          addDiag("❌ map error: " + (e?.error?.message ?? JSON.stringify(e)));
        });

        map.once("load", () => {
          map.resize();
          addDiag("✅ map loaded!");
        });

        mapRef.current = map;
        addDiag("🗺️ Map() created");
      } catch (e: any) {
        addDiag("❌ Map() threw: " + e?.message);
      }
    };

    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (!mapRef.current) {
        addDiag(`🔄 RO: ${Math.round(rect.width)}×${Math.round(rect.height)}`);
        if (window.maplibregl) initMap();
      } else {
        mapRef.current.resize();
      }
    });
    ro.observe(el);

    loadMaplibre(initMap);

    return () => { ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  return (
    <div ref={containerRef} className={className} style={{ height }}>
      {/* DIAGNOSTIC OVERLAY — remove after fixing */}
      <div style={{
        position: "absolute", top: 8, left: 8, zIndex: 9999,
        background: "rgba(0,0,0,0.75)", color: "#0f0", fontFamily: "monospace",
        fontSize: 11, padding: "6px 10px", borderRadius: 6, maxWidth: 280,
        pointerEvents: "none", lineHeight: 1.5,
      }}>
        {diag.map((d, i) => <div key={i}>{d}</div>)}
      </div>
    </div>
  );
}

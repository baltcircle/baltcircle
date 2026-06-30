import { useEffect, useRef, useState } from "react";
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

const buildStyle = () => ({
  version: 8,
  sources: { kaliningrad: { type: "vector", url: "/tiles/data/kaliningrad.json" } },
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
  link.id = "maplibre-css"; link.rel = "stylesheet";
  link.href = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";
  document.head.appendChild(link);
}

function loadMaplibre(cb: (err?: string) => void) {
  if (window.maplibregl) { cb(); return; }
  const existing = document.getElementById("maplibre-js") as HTMLScriptElement | null;
  if (existing) {
    existing.addEventListener("load", () => cb());
    existing.addEventListener("error", () => cb("script onerror"));
    return;
  }
  const script = document.createElement("script");
  script.id = "maplibre-js";
  script.src = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
  script.onload = () => cb();
  script.onerror = () => cb("CDN blocked/failed");
  document.head.appendChild(script);
}

export function MapLibreMap({
  parkings = [], mapObjects = [], ride, height = "100%",
  showLabels = false, center, className,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const diagRef = useRef<string[]>(["⏳ start"]);
  const [diagLines, setDiagLines] = useState<string[]>(["⏳ start"]);

  const log = (msg: string) => {
    console.log("[MapDiag]", msg);
    diagRef.current = [...diagRef.current.slice(-12), msg];
    setDiagLines([...diagRef.current]);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) { log("❌ no el"); return; }

    ensureMaplibreCSS();
    log("1 CSS ok");

    const initMap = (cdnErr?: string) => {
      if (cdnErr) { log("❌ CDN: " + cdnErr); return; }
      if (mapRef.current) { log("skip:already"); return; }

      log("2 CDN ready");

      const ml = window.maplibregl;
      if (!ml) { log("❌ ml undef"); return; }
      log("3 ml ok v:" + (ml.version ?? "?"));

      const rect = el.getBoundingClientRect();
      log("4 rect " + Math.round(rect.width) + "×" + Math.round(rect.height));

      if (rect.width === 0 || rect.height === 0) {
        log("⏳ 0×0 wait RO");
        return;
      }

      const sup = ml.supported();
      log("5 supported:" + sup);
      if (!sup) { log("❌ no WebGL"); return; }

      log("6 new Map...");
      try {
        const map = new ml.Map({
          container: el,
          style: buildStyle(),
          center: DEFAULT_CENTER,
          zoom: 11,
          attributionControl: false,
          trackResize: true,
        });
        log("7 Map()ok");

        map.addControl(new ml.AttributionControl({ compact: true }), "bottom-right");

        map.on("error", (e: any) => {
          const msg = e?.error?.message ?? e?.type ?? JSON.stringify(e).slice(0, 80);
          log("❌ mapevent: " + msg);
        });

        map.once("load", () => { map.resize(); log("✅ LOADED!"); });

        mapRef.current = map;
      } catch (e: any) {
        log("❌ throw: " + (e?.message ?? String(e)).slice(0, 80));
      }
    };

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (!mapRef.current) {
        log("RO " + Math.round(r.width) + "×" + Math.round(r.height));
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
      <div style={{
        position: "absolute", top: 8, left: 8, zIndex: 9999,
        background: "rgba(0,0,0,0.82)", color: "#0f0", fontFamily: "monospace",
        fontSize: 11, padding: "6px 10px", borderRadius: 6, maxWidth: 300,
        pointerEvents: "none", lineHeight: 1.6, whiteSpace: "pre",
      }}>
        {diagLines.join("\n")}
      </div>
    </div>
  );
}

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

const CDN_BASE       = "https://unpkg.com/maplibre-gl@4.7.1/dist";
const CDN_CSP_JS     = `${CDN_BASE}/maplibre-gl-csp.js`;
const CDN_WORKER_JS  = `${CDN_BASE}/maplibre-gl-csp-worker.js`;
const CDN_CSS        = `${CDN_BASE}/maplibre-gl.css`;

function ensureCSS() {
  if (document.getElementById("maplibre-css")) return;
  const link = document.createElement("link");
  link.id = "maplibre-css"; link.rel = "stylesheet"; link.href = CDN_CSS;
  document.head.appendChild(link);
}

function loadMaplibre(): Promise<string | undefined> {
  return new Promise((resolve) => {
    // Already loaded and Map constructor present
    if (window.maplibregl?.Map) { resolve(undefined); return; }

    const existing = document.getElementById("maplibre-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(undefined));
      existing.addEventListener("error", () => resolve("script onerror"));
      return;
    }

    const script = document.createElement("script");
    script.id = "maplibre-js";
    script.src = CDN_CSP_JS;
    script.onload = () => {
      try {
        // CSP variant has no embedded worker blob — point it at the standalone worker file
        window.maplibregl.setWorkerUrl(CDN_WORKER_JS);
        resolve(undefined);
      } catch (e: any) {
        resolve("setWorkerUrl threw: " + (e?.message ?? String(e)));
      }
    };
    script.onerror = () => resolve("CDN load failed");
    document.head.appendChild(script);
  });
}

export function MapLibreMap({
  parkings = [], mapObjects = [], ride, height = "100%",
  showLabels = false, center, className,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<any>(null);
  const diagRef      = useRef<string[]>(["⏳ loading..."]);
  const [diagLines, setDiagLines] = useState<string[]>(["⏳ loading..."]);

  const log = (msg: string) => {
    console.log("[Map]", msg);
    diagRef.current = [...diagRef.current.slice(-10), msg];
    setDiagLines([...diagRef.current]);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) { log("❌ no container"); return; }

    ensureCSS();

    let cancelled = false;

    const tryInit = () => {
      if (cancelled || mapRef.current) return;

      const ml = window.maplibregl;
      if (!ml?.Map) { log("⏳ ml not ready"); return; }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        log(`⏳ 0×0 (${Math.round(rect.width)}×${Math.round(rect.height)})`);
        return;
      }

      log(`rect ok ${Math.round(rect.width)}×${Math.round(rect.height)} — new Map()...`);
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
        map.on("error", (e: any) => log("❌ " + (e?.error?.message ?? JSON.stringify(e)).slice(0, 80)));
        map.once("load", () => { map.resize(); log("✅ map loaded!"); });

        mapRef.current = map;
        log("Map() created ✓");
      } catch (e: any) {
        log("❌ Map() threw: " + (e?.message ?? String(e)).slice(0, 80));
      }
    };

    // ResizeObserver: init on first non-zero size, then keep canvas in sync
    const ro = new ResizeObserver(() => {
      if (!mapRef.current) tryInit();
      else mapRef.current.resize();
    });
    ro.observe(el);

    // Load CSP maplibre (no Blob worker), then attempt init
    loadMaplibre().then((err) => {
      if (cancelled) return;
      if (err) { log("❌ load: " + err); return; }
      log("CDN ok v" + (window.maplibregl?.version ?? "?"));
      tryInit();
    });

    return () => {
      cancelled = true;
      ro.disconnect();
      // No map.remove() — MapPage is always-mounted overlay
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  return (
    <div ref={containerRef} className={className} style={{ height }}>
      {/* DIAGNOSTIC OVERLAY — remove once map is confirmed working */}
      <div style={{
        position: "absolute", top: 8, left: 8, zIndex: 9999,
        background: "rgba(0,0,0,0.82)", color: "#0f0", fontFamily: "monospace",
        fontSize: 11, padding: "6px 10px", borderRadius: 6, maxWidth: 320,
        pointerEvents: "none", lineHeight: 1.6, whiteSpace: "pre",
      }}>
        {diagLines.join("\n")}
      </div>
    </div>
  );
}

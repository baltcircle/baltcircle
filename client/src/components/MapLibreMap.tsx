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

// Build style with an inline vector source (tiles[] already absolute — no url: indirection).
// This bypasses any server-side TileJSON rewrite issues entirely.
const buildStyle = (tileUrl: string, minzoom: number, maxzoom: number): object => ({
  version: 8,
  // No glyphs — no symbol layers, fonts not needed
  sources: {
    kaliningrad: { type: "vector", tiles: [tileUrl], minzoom, maxzoom },
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
  ],
});

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
      existing.addEventListener("error", () => reject(new Error("script failed")));
      return;
    }
    const s = document.createElement("script");
    s.id = "maplibre-js"; s.src = CDN_CSP_JS;
    s.onload = () => { try { window.maplibregl.setWorkerUrl(CDN_WORKER_JS); resolve(); } catch(e){reject(e);} };
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
  const diagRef      = useRef<string[]>(["init"]);
  const [diag, setDiag] = useState<string[]>(["init"]);

  const log = (m: string) => {
    console.log("[Map]", m);
    diagRef.current = [...diagRef.current.slice(-10), m];
    setDiag([...diagRef.current]);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    ensureCSS();
    let cancelled = false;

    const initMap = (tileUrl: string, minzoom: number, maxzoom: number) => {
      if (cancelled || mapRef.current) return;
      const ml = window.maplibregl;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) { log(`0×0`); return; }

      log(`Map() ${Math.round(width)}×${Math.round(h)}`);
      log("tile:" + tileUrl.slice(0, 70));
      try {
        let tileReqCount = 0;
        const map = new ml.Map({
          container: el, style: buildStyle(tileUrl, minzoom, maxzoom),
          center: DEFAULT_CENTER, zoom: 10,
          attributionControl: false, trackResize: true,
          workerCount: 0,
          transformRequest: (url: string) => {
            if (url.includes("/tiles/data/kaliningrad/")) {
              tileReqCount++;
              if (tileReqCount <= 2) log(`req#${tileReqCount}:${url.slice(-30)}`);
            }
            return { url };
          },
        });
        map.addControl(new ml.AttributionControl({ compact: true }), "bottom-right");

        map.on("error", (e: any) => {
          log("ERR:" + (e?.error?.message ?? JSON.stringify(e)).slice(0, 70));
        });

        map.on("sourcedata", (e: any) => {
          if (e.sourceId === "kaliningrad") {
            log(`src ${e.isSourceLoaded ? "loaded" : "loading"} tile=${!!e.tile}`);
          }
        });

        // Count render frames to detect if WebGL is working at all
        let renderCount = 0;
        map.on("render", () => { renderCount++; });

        map.once("styledata", () => log("styledata ✓"));
        map.once("idle",      () => log("idle ✓"));

        map.once("load", () => {
          map.resize();
          log(`LOADED! ${map.getCanvas().width}×${map.getCanvas().height}`);
        });

        // 5s snapshot
        setTimeout(() => {
          if (mapRef.current !== map) return;
          log(`5s: renders=${renderCount} tileReqs=${tileReqCount} loaded=${map.loaded()}`);
        }, 5000);

        mapRef.current = map;
        log("created ✓");
      } catch (e: any) {
        log("THROW:" + (e?.message ?? e).slice(0, 70));
      }
    };

    // Fetch TileJSON ourselves and patch tiles[] to absolute URLs on the client.
    // This completely bypasses server-side rewrite and is reliable regardless of proxy.
    const tryInit = () => {
      if (cancelled || mapRef.current) return;
      const ml = window.maplibregl;
      if (!ml?.Map) return;

      const origin = window.location.origin;
      log("fetch tj...");
      fetch(`${origin}/tiles/data/kaliningrad.json`)
        .then(r => r.json())
        .then((j: any) => {
          if (cancelled) return;
          // Patch tiles[] to absolute URLs using client-side origin
          const rawTiles: string[] = Array.isArray(j.tiles) ? j.tiles : [];
          const tileUrl = rawTiles.map((u: string) =>
            u.startsWith("http") ? u : `${origin}${u.startsWith("/") ? "" : "/"}${u}`
          )[0] ?? `${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf`;
          const minzoom = j.minzoom ?? 0;
          const maxzoom = j.maxzoom ?? 14;
          log(`tj ok minz=${minzoom} maxz=${maxzoom}`);
          // Test actual tile fetch at z=11 center of Kaliningrad (lng=20.275, lat=54.945)
          // z=11: x=1193, y=630
          // Test z=10 (confirmed working) and z=11 (correct coords for Kaliningrad center)
          const t10 = tileUrl.replace("{z}","10").replace("{x}","569").replace("{y}","324");
          const t11 = tileUrl.replace("{z}","11").replace("{x}","1139").replace("{y}","648");
          Promise.all([
            fetch(t10,{cache:"no-store"}).then(async r=>({z:10,s:r.status,b:(await r.arrayBuffer()).byteLength})),
            fetch(t11,{cache:"no-store"}).then(async r=>({z:11,s:r.status,b:(await r.arrayBuffer()).byteLength})),
          ]).then(rs => rs.forEach(r => log(`t${r.z} http=${r.s} bytes=${r.b}`))).catch(e=>log("tERR:"+(e?.message??e)));
          initMap(tileUrl, minzoom, maxzoom);
        })
        .catch((e: any) => {
          if (cancelled) return;
          log("tj ERR:" + (e?.message ?? e));
          // Fallback: use hardcoded tile URL
          initMap(`${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf`, 0, 14);
        });
    };

    const ro = new ResizeObserver(() => {
      if (!mapRef.current) tryInit(); else mapRef.current.resize();
    });
    ro.observe(el);

    loadMaplibre()
      .then(() => { if (!cancelled) { log("CDN ok"); tryInit(); } })
      .catch((e: any) => log("CDN ERR:" + e?.message));

    return () => { cancelled = true; ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  return (
    <div ref={containerRef} className={className} style={{ height }}>
      <div style={{
        position:"absolute", top:8, left:8, zIndex:9999,
        background:"rgba(0,0,0,0.85)", color:"#0f0", fontFamily:"monospace",
        fontSize:11, padding:"6px 10px", borderRadius:6, maxWidth:340,
        pointerEvents:"none", lineHeight:1.6, whiteSpace:"pre",
      }}>
        {diag.join("\n")}
      </div>
    </div>
  );
}

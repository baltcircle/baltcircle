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

// Kaliningrad oblast boundary — smooth 183-point contour from OSM/Nominatim
// Used both for the boundary line and the outside mask
const OBLAST_RING: [number,number][] = [[19.4041722,54.6039],[19.6469351,54.4533945],[20.3320253,54.401148],[20.5151433,54.380605],[20.5839622,54.3780224],[20.6310714,54.3663108],[20.6481087,54.3711832],[20.6894047,54.3722607],[20.8184351,54.3600119],[20.95134,54.3571288],[21.2612908,54.3292006],[21.3028467,54.3335395],[21.3238632,54.3293566],[21.4336849,54.3268998],[21.4461125,54.3182154],[21.5287523,54.3254213],[21.5701912,54.322015],[21.5774137,54.3255464],[21.7971082,54.3317947],[22.1794752,54.337202],[22.2257052,54.3437715],[22.2319748,54.3402794],[22.3187783,54.3405171],[22.3292505,54.3445398],[22.6415514,54.3537714],[22.680602,54.3602413],[22.7920021,54.3633232],[22.7671078,54.3848178],[22.736439,54.4429167],[22.7011825,54.4536136],[22.7041905,54.4682196],[22.6967551,54.4899537],[22.6959911,54.5050734],[22.6993587,54.5072524],[22.6845519,54.5184143],[22.6805881,54.5330304],[22.6918275,54.5421259],[22.6941061,54.5502258],[22.7133521,54.5638676],[22.7033373,54.5670738],[22.7000135,54.5760505],[22.6869968,54.5796815],[22.6838586,54.585972],[22.7055471,54.6028212],[22.7200327,54.6066158],[22.7205049,54.6166013],[22.7266746,54.6229442],[22.7487738,54.6308947],[22.7503422,54.6387348],[22.7416839,54.6426511],[22.7572045,54.6526151],[22.7307703,54.6664372],[22.7404927,54.6740434],[22.7377209,54.6796864],[22.7287189,54.6788602],[22.7233379,54.686016],[22.7292509,54.6979957],[22.7396631,54.6990178],[22.7369937,54.7030058],[22.748963,54.7064386],[22.748372,54.7120259],[22.7387334,54.7168932],[22.7459045,54.7255137],[22.7415954,54.7280593],[22.743582,54.7314983],[22.7668921,54.7379598],[22.7768452,54.7487222],[22.7740342,54.7511817],[22.7825368,54.7490754],[22.7905211,54.7543705],[22.7999618,54.7533319],[22.7967679,54.7515959],[22.7995853,54.7475358],[22.8071478,54.7480062],[22.8063297,54.7525734],[22.8157483,54.7554627],[22.8050067,54.7543649],[22.8130328,54.7665189],[22.8440987,54.7668468],[22.8485646,54.7746085],[22.8595635,54.777671],[22.848327,54.7856667],[22.8548107,54.7898423],[22.8779086,54.790805],[22.8718124,54.7973485],[22.8733349,54.8054362],[22.886659,54.8140818],[22.8709874,54.8202099],[22.8800564,54.8254428],[22.8764816,54.833827],[22.8587544,54.838788],[22.8690841,54.8531529],[22.8396881,54.8642311],[22.8436975,54.8752266],[22.8553168,54.886332],[22.8474088,54.8902355],[22.8462497,54.8974232],[22.8361318,54.8986624],[22.8358993,54.9038523],[22.8204005,54.9119829],[22.7932571,54.9037185],[22.7830164,54.9248335],[22.7687225,54.9234258],[22.7618697,54.9169252],[22.7544855,54.9186055],[22.7493738,54.924978],[22.7662757,54.9355388],[22.7427369,54.9390508],[22.7279156,54.954756],[22.726138,54.9631794],[22.7071681,54.9735415],[22.690025,54.9716031],[22.6876775,54.9807084],[22.6780717,54.9875007],[22.6593687,54.9818774],[22.6683238,54.9692085],[22.6638088,54.9645672],[22.6440633,54.9698957],[22.643102,54.9840125],[22.636244,54.9850762],[22.626549,54.9956004],[22.6250488,55.0041488],[22.6141948,55.0127112],[22.6035819,55.0134509],[22.5961883,55.0257801],[22.5974837,55.0459936],[22.5903001,55.0540966],[22.5892361,55.070243],[22.545168,55.0652671],[22.4705972,55.0445261],[22.4254307,55.0539613],[22.3945804,55.0532967],[22.3483005,55.0616275],[22.2913595,55.064764],[22.2180995,55.0603453],[22.1856966,55.0536778],[22.1585655,55.0556385],[22.13367,55.0464204],[22.1205641,55.0277686],[22.0758154,55.0249977],[22.0476528,55.0339385],[22.0369134,55.042544],[22.0308356,55.0553554],[22.040485,55.0767844],[22.0324081,55.084098],[21.9977573,55.0867348],[21.9655396,55.0738781],[21.9163905,55.0809924],[21.8794223,55.0936312],[21.8485167,55.097456],[21.8162719,55.1186837],[21.7779088,55.1194201],[21.7225988,55.1330531],[21.7098415,55.1512874],[21.6491949,55.1808113],[21.5946378,55.1879109],[21.570132,55.1981279],[21.5400739,55.1962191],[21.5149497,55.1852588],[21.5015124,55.1868198],[21.4880756,55.201002],[21.4493709,55.2214947],[21.4312163,55.2523258],[21.3843708,55.2936996],[21.3323812,55.275271],[21.2999787,55.2542043],[21.2709829,55.2450059],[21.0983616,55.2563884],[20.9537744,55.2808344],[20.6557167,55.3842167],[20.4285879,55.1976283],[20.4010838,55.1806297],[20.2018234,55.1601503],[19.9215027,55.1580929],[19.8239352,55.1400153],[19.7311173,55.1016379],[19.6839809,55.0652463],[19.605774,54.979627],[19.584042,54.909055],[19.617694,54.827053],[19.60899,54.783954],[19.577567,54.736809],[19.4041722,54.6039]];

// Boundary line source: just the ring as a closed polygon
const KALININGRAD_BOUNDARY = {
  type: "FeatureCollection" as const,
  features: [{
    type: "Feature" as const,
    geometry: { type: "Polygon" as const, coordinates: [OBLAST_RING] },
    properties: {},
  }],
};

// Mask source: inverted polygon (world bbox with oblast as a hole)
// This dims everything outside the oblast, making the boundary feel natural
const OBLAST_MASK = {
  type: "FeatureCollection" as const,
  features: [{
    type: "Feature" as const,
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [[15.5,52.5],[25.5,52.5],[25.5,57],[15.5,57],[15.5,52.5]],
        [[19.4041722,54.6039],[19.577567,54.736809],[19.60899,54.783954],[19.617694,54.827053],[19.584042,54.909055],[19.605774,54.979627],[19.6839809,55.0652463],[19.7311173,55.1016379],[19.8239352,55.1400153],[19.9215027,55.1580929],[20.2018234,55.1601503],[20.4010838,55.1806297],[20.4285879,55.1976283],[20.6557167,55.3842167],[20.9537744,55.2808344],[21.0983616,55.2563884],[21.2709829,55.2450059],[21.2999787,55.2542043],[21.3323812,55.275271],[21.3843708,55.2936996],[21.4312163,55.2523258],[21.4493709,55.2214947],[21.4880756,55.201002],[21.5015124,55.1868198],[21.5149497,55.1852588],[21.5400739,55.1962191],[21.570132,55.1981279],[21.5946378,55.1879109],[21.6491949,55.1808113],[21.7098415,55.1512874],[21.7225988,55.1330531],[21.7779088,55.1194201],[21.8162719,55.1186837],[21.8485167,55.097456],[21.8794223,55.0936312],[21.9163905,55.0809924],[21.9655396,55.0738781],[21.9977573,55.0867348],[22.0324081,55.084098],[22.040485,55.0767844],[22.0308356,55.0553554],[22.0369134,55.042544],[22.0476528,55.0339385],[22.0758154,55.0249977],[22.1205641,55.0277686],[22.13367,55.0464204],[22.1585655,55.0556385],[22.1856966,55.0536778],[22.2180995,55.0603453],[22.2913595,55.064764],[22.3483005,55.0616275],[22.3945804,55.0532967],[22.4254307,55.0539613],[22.4705972,55.0445261],[22.545168,55.0652671],[22.5892361,55.070243],[22.5903001,55.0540966],[22.5974837,55.0459936],[22.5961883,55.0257801],[22.6035819,55.0134509],[22.6141948,55.0127112],[22.6250488,55.0041488],[22.626549,54.9956004],[22.636244,54.9850762],[22.643102,54.9840125],[22.6440633,54.9698957],[22.6638088,54.9645672],[22.6683238,54.9692085],[22.6593687,54.9818774],[22.6780717,54.9875007],[22.6876775,54.9807084],[22.690025,54.9716031],[22.7071681,54.9735415],[22.726138,54.9631794],[22.7279156,54.954756],[22.7427369,54.9390508],[22.7662757,54.9355388],[22.7493738,54.924978],[22.7544855,54.9186055],[22.7618697,54.9169252],[22.7687225,54.9234258],[22.7830164,54.9248335],[22.7932571,54.9037185],[22.8204005,54.9119829],[22.8358993,54.9038523],[22.8361318,54.8986624],[22.8462497,54.8974232],[22.8474088,54.8902355],[22.8553168,54.886332],[22.8436975,54.8752266],[22.8396881,54.8642311],[22.8690841,54.8531529],[22.8587544,54.838788],[22.8764816,54.833827],[22.8800564,54.8254428],[22.8709874,54.8202099],[22.886659,54.8140818],[22.8733349,54.8054362],[22.8718124,54.7973485],[22.8779086,54.790805],[22.8548107,54.7898423],[22.848327,54.7856667],[22.8595635,54.777671],[22.8485646,54.7746085],[22.8440987,54.7668468],[22.8130328,54.7665189],[22.8050067,54.7543649],[22.8157483,54.7554627],[22.8063297,54.7525734],[22.8071478,54.7480062],[22.7995853,54.7475358],[22.7967679,54.7515959],[22.7999618,54.7533319],[22.7905211,54.7543705],[22.7825368,54.7490754],[22.7740342,54.7511817],[22.7768452,54.7487222],[22.7668921,54.7379598],[22.743582,54.7314983],[22.7415954,54.7280593],[22.7459045,54.7255137],[22.7387334,54.7168932],[22.748372,54.7120259],[22.748963,54.7064386],[22.7369937,54.7030058],[22.7396631,54.6990178],[22.7292509,54.6979957],[22.7233379,54.686016],[22.7287189,54.6788602],[22.7377209,54.6796864],[22.7404927,54.6740434],[22.7307703,54.6664372],[22.7572045,54.6526151],[22.7416839,54.6426511],[22.7503422,54.6387348],[22.7487738,54.6308947],[22.7266746,54.6229442],[22.7205049,54.6166013],[22.7200327,54.6066158],[22.7055471,54.6028212],[22.6838586,54.585972],[22.6869968,54.5796815],[22.7000135,54.5760505],[22.7033373,54.5670738],[22.7133521,54.5638676],[22.6941061,54.5502258],[22.6918275,54.5421259],[22.6805881,54.5330304],[22.6845519,54.5184143],[22.6993587,54.5072524],[22.6959911,54.5050734],[22.6967551,54.4899537],[22.7041905,54.4682196],[22.7011825,54.4536136],[22.736439,54.4429167],[22.7671078,54.3848178],[22.7920021,54.3633232],[22.680602,54.3602413],[22.6415514,54.3537714],[22.3292505,54.3445398],[22.3187783,54.3405171],[22.2319748,54.3402794],[22.2257052,54.3437715],[22.1794752,54.337202],[21.7971082,54.3317947],[21.5774137,54.3255464],[21.5701912,54.322015],[21.5287523,54.3254213],[21.4461125,54.3182154],[21.4336849,54.3268998],[21.3238632,54.3293566],[21.3028467,54.3335395],[21.2612908,54.3292006],[20.95134,54.3571288],[20.8184351,54.3600119],[20.6894047,54.3722607],[20.6481087,54.3711832],[20.6310714,54.3663108],[20.5839622,54.3780224],[20.5151433,54.380605],[20.3320253,54.401148],[19.6469351,54.4533945],[19.4041722,54.6039]],
      ],
    },
    properties: {},
  }],
};

// maxBounds: slightly larger than real oblast bounds so user can't scroll far outside
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
    { id: "background", type: "background", paint: { "background-color": "#e8f0f7" } },
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
    // Oblast boundary line — solid, drawn on top of mask
    {
      id: "oblast-boundary",
      type: "line",
      source: "kaliningrad-boundary",
      paint: {
        "line-color": "#3a6a9a",
        "line-width": 2,
        "line-opacity": 1,
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
        map.once("load", () => {
          map.resize();
          // Add outside-oblast mask dynamically after load
          // (geojson-vt handles inverted polygons better when added post-load)
          try {
            map.addSource("oblast-mask", {
              type: "geojson",
              data: OBLAST_MASK,
            });
            map.addLayer({
              id: "oblast-outside-mask",
              type: "fill",
              source: "oblast-mask",
              paint: {
                "fill-color": "#b8ccd8",
                "fill-opacity": 0.5,
              },
            }, "oblast-boundary"); // insert before boundary line
          } catch(e) {
            // layer may already exist on hot-reload
          }
        });
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

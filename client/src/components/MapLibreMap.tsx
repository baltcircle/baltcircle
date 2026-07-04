import { useEffect, useRef } from "react";
import type { MapObject, Parking, Ride } from "@shared/schema";
import { REAL_CENTER } from "@shared/geo";

declare global {
  interface Window {
    maplibregl: any;
    pmtilesProtocol: any;
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

// Real Kaliningrad oblast boundary — 183-point contour from OSM/Nominatim
const OBLAST_RING: [number, number][] = [[19.4041722,54.6039],[19.6469351,54.4533945],[20.3320253,54.401148],[20.5151433,54.380605],[20.5839622,54.3780224],[20.6310714,54.3663108],[20.6481087,54.3711832],[20.6894047,54.3722607],[20.8184351,54.3600119],[20.95134,54.3571288],[21.2612908,54.3292006],[21.3028467,54.3335395],[21.3238632,54.3293566],[21.4336849,54.3268998],[21.4461125,54.3182154],[21.5287523,54.3254213],[21.5701912,54.322015],[21.5774137,54.3255464],[21.7971082,54.3317947],[22.1794752,54.337202],[22.2257052,54.3437715],[22.2319748,54.3402794],[22.3187783,54.3405171],[22.3292505,54.3445398],[22.6415514,54.3537714],[22.680602,54.3602413],[22.7920021,54.3633232],[22.7671078,54.3848178],[22.736439,54.4429167],[22.7011825,54.4536136],[22.7041905,54.4682196],[22.6967551,54.4899537],[22.6959911,54.5050734],[22.6993587,54.5072524],[22.6845519,54.5184143],[22.6805881,54.5330304],[22.6918275,54.5421259],[22.6941061,54.5502258],[22.7133521,54.5638676],[22.7033373,54.5670738],[22.7000135,54.5760505],[22.6869968,54.5796815],[22.6838586,54.585972],[22.7055471,54.6028212],[22.7200327,54.6066158],[22.7205049,54.6166013],[22.7266746,54.6229442],[22.7487738,54.6308947],[22.7503422,54.6387348],[22.7416839,54.6426511],[22.7572045,54.6526151],[22.7307703,54.6664372],[22.7404927,54.6740434],[22.7377209,54.6796864],[22.7287189,54.6788602],[22.7233379,54.686016],[22.7292509,54.6979957],[22.7396631,54.6990178],[22.7369937,54.7030058],[22.748963,54.7064386],[22.748372,54.7120259],[22.7387334,54.7168932],[22.7459045,54.7255137],[22.7415954,54.7280593],[22.743582,54.7314983],[22.7668921,54.7379598],[22.7768452,54.7487222],[22.7740342,54.7511817],[22.7825368,54.7490754],[22.7905211,54.7543705],[22.7999618,54.7533319],[22.7967679,54.7515959],[22.7995853,54.7475358],[22.8071478,54.7480062],[22.8063297,54.7525734],[22.8157483,54.7554627],[22.8050067,54.7543649],[22.8130328,54.7665189],[22.8440987,54.7668468],[22.8485646,54.7746085],[22.8595635,54.777671],[22.848327,54.7856667],[22.8548107,54.7898423],[22.8779086,54.790805],[22.8718124,54.7973485],[22.8733349,54.8054362],[22.886659,54.8140818],[22.8709874,54.8202099],[22.8800564,54.8254428],[22.8764816,54.833827],[22.8587544,54.838788],[22.8690841,54.8531529],[22.8396881,54.8642311],[22.8436975,54.8752266],[22.8553168,54.886332],[22.8474088,54.8902355],[22.8462497,54.8974232],[22.8361318,54.8986624],[22.8358993,54.9038523],[22.8204005,54.9119829],[22.7932571,54.9037185],[22.7830164,54.9248335],[22.7687225,54.9234258],[22.7618697,54.9169252],[22.7544855,54.9186055],[22.7493738,54.924978],[22.7662757,54.9355388],[22.7427369,54.9390508],[22.7279156,54.954756],[22.726138,54.9631794],[22.7071681,54.9735415],[22.690025,54.9716031],[22.6876775,54.9807084],[22.6780717,54.9875007],[22.6593687,54.9818774],[22.6683238,54.9692085],[22.6638088,54.9645672],[22.6440633,54.9698957],[22.643102,54.9840125],[22.636244,54.9850762],[22.626549,54.9956004],[22.6250488,55.0041488],[22.6141948,55.0127112],[22.6035819,55.0134509],[22.5961883,55.0257801],[22.5974837,55.0459936],[22.5903001,55.0540966],[22.5892361,55.070243],[22.545168,55.0652671],[22.4705972,55.0445261],[22.4254307,55.0539613],[22.3945804,55.0532967],[22.3483005,55.0616275],[22.2913595,55.064764],[22.2180995,55.0603453],[22.1856966,55.0536778],[22.1585655,55.0556385],[22.13367,55.0464204],[22.1205641,55.0277686],[22.0758154,55.0249977],[22.0476528,55.0339385],[22.0369134,55.042544],[22.0308356,55.0553554],[22.040485,55.0767844],[22.0324081,55.084098],[21.9977573,55.0867348],[21.9655396,55.0738781],[21.9163905,55.0809924],[21.8794223,55.0936312],[21.8485167,55.097456],[21.8162719,55.1186837],[21.7779088,55.1194201],[21.7225988,55.1330531],[21.7098415,55.1512874],[21.6491949,55.1808113],[21.5946378,55.1879109],[21.570132,55.1981279],[21.5400739,55.1962191],[21.5149497,55.1852588],[21.5015124,55.1868198],[21.4880756,55.201002],[21.4493709,55.2214947],[21.4312163,55.2523258],[21.3843708,55.2936996],[21.3323812,55.275271],[21.2999787,55.2542043],[21.2709829,55.2450059],[21.0983616,55.2563884],[20.9537744,55.2808344],[20.6557167,55.3842167],[20.4285879,55.1976283],[20.4010838,55.1806297],[20.2018234,55.1601503],[19.9215027,55.1580929],[19.8239352,55.1400153],[19.7311173,55.1016379],[19.6839809,55.0652463],[19.605774,54.979627],[19.584042,54.909055],[19.617694,54.827053],[19.60899,54.783954],[19.577567,54.736809],[19.4041722,54.6039]];

const KALININGRAD_BOUNDARY = {
  type: "FeatureCollection" as const,
  features: [{ type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [OBLAST_RING] }, properties: {} }],
};

const MAX_BOUNDS: [number, number, number, number] = [18.3, 53.2, 26.8, 57.3];

// PALETTE - swap any value by HEX to re-theme the whole map
const COLORS = {
  land:            "#eef1e8", // land background (OpenMapTiles has no land layer)
  water:           "#9fc9e0", // sea, gulfs, lakes, rivers
  boundaryCountry: "#8a6fae", // RU / LT / PL state border (admin_level 2)
  boundaryRegion:  "#9a86b8", // oblast / region border (admin_level 4)
} as const;

// PMTiles URL — loaded from /pmtiles_url.txt (written by CI after generation)
// Fallback to old /tiles proxy if PMTiles not yet available
const PMTILES_CDN = "https://unpkg.com/pmtiles@3/dist/pmtiles.js";
// PMTiles file URL — updated by CI on each regeneration
// PMTiles served same-origin via Express (Range request support, no CORS issues)
const PMTILES_URL = "/kaliningrad.pmtiles";

const buildStyle = (tileSource: { type: "pmtiles"; url: string } | { type: "xyz"; url: string }, minzoom: number, maxzoom: number): object => ({
  version: 8,
  glyphs: "/glyphs/{fontstack}/{range}.pbf",
  sources: {
    kaliningrad: tileSource.type === "pmtiles"
      ? { type: "vector", url: `pmtiles://${tileSource.url}`, minzoom, maxzoom }
      : { type: "vector", tiles: [tileSource.url], minzoom, maxzoom },
    "kaliningrad-boundary": { type: "geojson", data: KALININGRAD_BOUNDARY },
  },
  layers: [
    // Background = LAND colour. OpenMapTiles has no land layer, only water —
    // so ocean + lakes are drawn on top as real polygons from the water layer.
    { id: "background", type: "background", paint: { "background-color": COLORS.water } },

    // ── LAND MASK (draws oblast contour as land over the water background) ──
    // Interim fix for the broken ocean polygon in PMTiles data (floods inland tiles at z7+).
    // Sea = water background outside the contour; land = COLORS.land inside it.
    { id: "land-mask", type: "fill", source: "kaliningrad-boundary", paint: { "fill-color": COLORS.land } },

    // ── LANDCOVER ────────────────────────────────────────────────────────────
    {
      id: "landcover", type: "fill", source: "kaliningrad", "source-layer": "landcover",
      paint: {
        "fill-color": ["match", ["get", "class"],
          "farmland",   "#ede7d5",
          "allotments", "#e8e0c8",
          "grass",      "#d4edda",
          "grassland",  "#d4edda",
          "forest",     "#b5d5a0",
          "wood",       "#b5d5a0",
          "wetland",    "#c8dfd0",
          "swamp",      "#c8dfd0",
          "sand",       "#f0e8c8",
          "#e8e0d0",
        ],
        "fill-opacity": 0.9,
      },
    },

    // ── WATER (lakes/rivers polygons — drawn on top of landcover) ────────────
    {
      id: "water-lake", type: "fill", source: "kaliningrad", "source-layer": "water",
      filter: ["!=", ["get", "class"], "ocean"],
      paint: { "fill-color": COLORS.water },
    },

    // ── LANDUSE ──────────────────────────────────────────────────────────────
    {
      id: "landuse", type: "fill", source: "kaliningrad", "source-layer": "landuse",
      paint: {
        "fill-color": ["match", ["get", "class"],
          "residential",  "#f0ece4",
          "commercial",   "#f5edd8",
          "industrial",   "#e8ddd0",
          "cemetery",     "#d4e8d0",
          "military",     "#e8d8c8",
          "pitch",        "#c8e8c0",
          "playground",   "#d8f0d0",
          "park",         "#c0e8b8",
          "forest",       "#b5d5a0",
          "railway",      "#ddd0c8",
          "#ede8e0",
        ],
        "fill-opacity": 0.85,
      },
    },

    // ── WATERWAYS ────────────────────────────────────────────────────────────
    {
      id: "waterway-river", type: "line", source: "kaliningrad", "source-layer": "waterway",
      filter: ["in", ["get", "class"], ["literal", ["river", "canal"]]],
      paint: {
        "line-color": "#a8d5e8",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 12, 3, 14, 5],
      },
    },
    {
      id: "waterway-stream", type: "line", source: "kaliningrad", "source-layer": "waterway",
      filter: ["in", ["get", "class"], ["literal", ["stream", "drain", "ditch"]]],
      minzoom: 12,
      paint: {
        "line-color": "#a8d5e8",
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 14, 1.5],
      },
    },

    // ── ROADS — casing ───────────────────────────────────────────────────────
    {
      id: "road-motorway-case", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "motorway"],
      paint: { "line-color": "#e8a000", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2, 12, 5, 14, 9] },
    },
    {
      id: "road-trunk-case", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "trunk"],
      paint: { "line-color": "#e8c060", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 12, 4, 14, 7] },
    },
    {
      id: "road-primary-case", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "primary"],
      paint: { "line-color": "#d4c090", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 12, 3, 14, 6] },
    },
    {
      id: "road-secondary-case", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]],
      minzoom: 10,
      paint: { "line-color": "#c8b898", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 12, 2, 14, 5] },
    },

    // ── ROADS — fill ─────────────────────────────────────────────────────────
    {
      id: "road-motorway", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "motorway"],
      paint: { "line-color": "#ffc840", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 3.5, 14, 7] },
    },
    {
      id: "road-trunk", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "trunk"],
      paint: { "line-color": "#fde090", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 12, 2.5, 14, 5] },
    },
    {
      id: "road-primary", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "primary"],
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 12, 2, 14, 4.5] },
    },
    {
      id: "road-secondary", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["secondary", "tertiary"]]],
      minzoom: 10,
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 12, 1.5, 14, 3.5] },
    },
    {
      id: "road-minor", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor", "service"]]],
      minzoom: 12,
      paint: { "line-color": "#f8f4ee", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 14, 2] },
    },
    {
      id: "rail", type: "line", source: "kaliningrad", "source-layer": "transportation",
      filter: ["==", ["get", "class"], "rail"],
      minzoom: 10,
      paint: { "line-color": "#bbb0a8", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 2], "line-dasharray": [2, 2] },
    },

    // ── BUILDINGS ────────────────────────────────────────────────────────────
    {
      id: "building", type: "fill", source: "kaliningrad", "source-layer": "building",
      minzoom: 13,
      paint: {
        "fill-color": "#ddd6cc",
        "fill-outline-color": "#c8bfb5",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 14, 0.9],
      },
    },

    // ── ADMIN BOUNDARIES (from vector data) ──────────────────────────────────
    {
      id: "boundary-region", type: "line", source: "kaliningrad", "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 4], minzoom: 6,
      paint: {
        "line-color": COLORS.boundaryRegion,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 10, 1.6],
        "line-dasharray": [2, 2], "line-opacity": 0.7,
      },
    },
    {
      id: "boundary-country", type: "line", source: "kaliningrad", "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 2],
      paint: {
        "line-color": COLORS.boundaryCountry,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.2, 9, 2.2, 12, 3],
        "line-dasharray": [3, 1.5], "line-opacity": 0.85,
      },
    },

    // ── ROAD NAMES ───────────────────────────────────────────────────────────
    {
      id: "road-labels", type: "symbol", source: "kaliningrad", "source-layer": "transportation_name",
      minzoom: 12,
      filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary", "trunk", "motorway"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:ru"], ["get", "name"], ["get", "name:latin"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 14, 12],
        "symbol-placement": "line",
        "text-max-angle": 30,
        "text-padding": 5,
      },
      paint: { "text-color": "#5a4a3a", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
    },

    // ── WATERWAY NAMES ───────────────────────────────────────────────────────
    {
      id: "waterway-labels", type: "symbol", source: "kaliningrad", "source-layer": "waterway",
      minzoom: 11,
      filter: ["in", ["get", "class"], ["literal", ["river", "canal"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:ru"], ["get", "name"], ["get", "name:latin"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "symbol-placement": "line",
        "text-max-angle": 30,
      },
      paint: { "text-color": "#3a7ab0", "text-halo-color": "rgba(255,255,255,0.8)", "text-halo-width": 1.5 },
    },

    // ── PLACE LABELS ─────────────────────────────────────────────────────────
    {
      id: "place-labels", type: "symbol", source: "kaliningrad", "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town", "village", "suburb", "hamlet"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:ru"], ["get", "name"], ["get", "name:latin"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"],
          6,  ["match", ["get", "class"], "city", 14, "town", 11, 9],
          12, ["match", ["get", "class"], "city", 20, "town", 15, 12],
        ],
        "text-max-width": 8,
        "text-anchor": "center",
        "text-padding": 3,
        "symbol-sort-key": ["match", ["get", "class"], "city", 1, "town", 2, "village", 3, 4],
      },
      paint: { "text-color": "#2d3a4a", "text-halo-color": "rgba(255,255,255,0.9)", "text-halo-width": 1.5 },
    },

    // ── HOUSE NUMBERS ────────────────────────────────────────────────────────
    {
      id: "housenumber-labels", type: "symbol", source: "kaliningrad", "source-layer": "housenumber",
      minzoom: 14,
      layout: {
        "text-field": ["get", "housenumber"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 9,
      },
      paint: { "text-color": "#7a6a55", "text-halo-color": "rgba(255,255,255,0.8)", "text-halo-width": 1 },
    },

    // ── POI LABELS ───────────────────────────────────────────────────────────
    {
      id: "poi-labels", type: "symbol", source: "kaliningrad", "source-layer": "poi",
      minzoom: 13,
      filter: ["<=", ["get", "rank"], 3],
      layout: {
        "text-field": ["coalesce", ["get", "name:ru"], ["get", "name"], ["get", "name:latin"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "text-max-width": 7,
        "text-offset": [0, 1],
      },
      paint: { "text-color": "#5a4a6a", "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.5 },
    },
  ],
});

// ── CDN ───────────────────────────────────────────────────────────────────────
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

async function makeWorkerBlobUrl(): Promise<string | null> {
  try {
    const resp = await fetch(CDN_WORKER_JS);
    const text = await resp.text();
    return URL.createObjectURL(new Blob([text], { type: "application/javascript" }));
  } catch { return null; }
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
        try { window.maplibregl.setWorkerUrl(blobUrl ?? CDN_WORKER_JS); resolve(); }
        catch (e) { reject(e); }
      });
    };
    s.onerror = () => reject(new Error("CDN failed"));
    document.head.appendChild(s);
  });
}

/** Load pmtiles.js from CDN and register protocol with maplibregl */
function loadPMTiles(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.pmtilesProtocol) { resolve(); return; }
    const existing = document.getElementById("pmtiles-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("pmtiles CDN failed")));
      return;
    }
    const s = document.createElement("script");
    s.id = "pmtiles-js"; s.src = PMTILES_CDN;
    s.onload = () => {
      try {
        const pmtiles = (window as any).pmtiles;
        if (!pmtiles) throw new Error("pmtiles not found on window");
        const protocol = new pmtiles.Protocol();
        window.maplibregl.addProtocol("pmtiles", protocol.tile.bind(protocol));
        window.pmtilesProtocol = protocol;
        resolve();
      } catch (e) { reject(e); }
    };
    s.onerror = () => reject(new Error("pmtiles CDN failed"));
    document.head.appendChild(s);
  });
}

// ── COMPONENT ─────────────────────────────────────────────────────────────────
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

    const initMap = (
      tileSource: { type: "pmtiles"; url: string } | { type: "xyz"; url: string },
      minzoom: number,
      maxzoom: number
    ) => {
      if (cancelled || mapRef.current) return;
      const ml = window.maplibregl;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return;
      try {
        const map = new ml.Map({
          container: el,
          style: buildStyle(tileSource, minzoom, maxzoom),
          center: DEFAULT_CENTER,
          zoom: 10,
          maxBounds: MAX_BOUNDS,
          attributionControl: false,
          trackResize: true,
        });
        map.addControl(new ml.AttributionControl({ compact: true }), "bottom-right");
        map.once("load", () => map.resize());
        mapRef.current = map;
      } catch { /* WebGL unavailable */ }
    };

    const tryInitPMTiles = async () => {
      if (cancelled || mapRef.current) return;
      try {
        await loadPMTiles();
        if (!cancelled) initMap({ type: "pmtiles", url: PMTILES_URL }, 0, 14);
      } catch {
        // Fallback: use old /tiles proxy
        tryInitXYZ();
      }
    };

    const tryInitXYZ = () => {
      if (cancelled || mapRef.current) return;
      const origin = window.location.origin;
      fetch(`${origin}/tiles/data/kaliningrad.json`)
        .then(r => r.json())
        .then((j: any) => {
          if (cancelled) return;
          const rawTiles: string[] = Array.isArray(j.tiles) ? j.tiles : [];
          const tileUrl = rawTiles.map((u: string) =>
            u.startsWith("http") ? u : `${origin}${u.startsWith("/") ? "" : "/"}${u}`
          )[0] ?? `${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf`;
          initMap({ type: "xyz", url: tileUrl }, j.minzoom ?? 0, j.maxzoom ?? 14);
        })
        .catch(() => {
          if (!cancelled) initMap({ type: "xyz", url: `${window.location.origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf` }, 0, 14);
        });
    };

    const ro = new ResizeObserver(() => {
      if (!mapRef.current) tryInitPMTiles(); else mapRef.current.resize();
    });
    ro.observe(el);

    loadMaplibre()
      .then(() => { if (!cancelled) tryInitPMTiles(); })
      .catch(() => { /* CDN unavailable */ });

    return () => { cancelled = true; ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  return <div ref={containerRef} className={className} style={{ height }} />;
}
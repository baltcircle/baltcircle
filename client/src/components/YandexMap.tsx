import { useEffect, useRef, useState } from "react";
import type { Bike, Parking, ZoneRow, Ride } from "@shared/schema";
import {
  COAST_ROUTES, REAL_TOWNS, REAL_CENTER, REAL_ZONES, ROUTE_WAYPOINTS, mapToReal,
} from "@shared/geo";
import { CoastMap } from "./CoastMap";

interface Props {
  bikes?: Bike[];
  parkings?: Parking[];
  zones?: ZoneRow[];
  ride?: Ride | null;
  selectedBikeId?: string | null;
  onSelectBike?: (id: string) => void;
  height?: number | string;
  showLabels?: boolean;
  interactive?: boolean;
  liveLocation?: { x: number; y: number } | null;
}

// Resolved brand-ish colors (Yandex overlays can't read CSS variables).
const SEA = "#1d6f8e";
const FOAM = "#ffffff";

function bikeColor(status: string) {
  switch (status) {
    case "available": return "#26a884";
    case "rented": return SEA;
    case "maintenance": return "#d64545";
    case "reserved": return "#e0972a";
    default: return "#8a8f96";
  }
}

function zoneStyle(kind: string) {
  if (kind === "forbidden")
    return { fill: "rgba(214,69,69,0.16)", stroke: "#d64545" };
  if (kind === "slow")
    return { fill: "rgba(224,151,42,0.18)", stroke: "#c9831f" };
  return { fill: "rgba(29,111,142,0.07)", stroke: SEA };
}

// Yandex multiRouter routing mode to attempt, in order of preference.
// v2.1 has no dedicated bicycle router, so we fall back to pedestrian
// (closest to a cycling profile) then driving, and label it as an MVP preview.
const ROUTE_MODES: { type: string; label: string }[] = [
  { type: "pedestrian", label: "пешеходный" },
  { type: "auto", label: "автомобильный" },
  { type: "masstransit", label: "общественный транспорт" },
];

export function YandexMap(props: Props) {
  const {
    bikes = [], parkings = [], zones = [], ride = null,
    selectedBikeId, onSelectBike, height = 520,
    interactive = true,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const ymapsRef = useRef<any>(null);
  const overlaysRef = useRef<any | null>(null); // GeoObjectCollection for dynamic markers
  const onSelectRef = useRef(onSelectBike);
  onSelectRef.current = onSelectBike;

  const [failed, setFailed] = useState(false);
  // Set when route construction falls back to a non-bicycle Yandex mode so the
  // UI can show an honest MVP-preview note.
  const [routeNote, setRouteNote] = useState<string | null>(null);

  // Initialise the map once.
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    import("@/lib/yandexMaps")
      .then(({ loadYandexMaps }) => loadYandexMaps())
      .then((ymaps) => {
        if (cancelled || !containerRef.current) return;
        ymapsRef.current = ymaps;

        const map = new ymaps.Map(
          containerRef.current,
          {
            center: REAL_CENTER,
            zoom: 12,
            controls: interactive ? ["zoomControl", "geolocationControl"] : [],
          },
          { suppressMapOpenBlock: true },
        );
        if (!interactive) {
          map.behaviors.disable(["scrollZoom", "drag", "dblClickZoom", "multiTouch"]);
        }
        mapRef.current = map;

        // Static overlays (zones, towns) drawn once from real coordinates.
        drawStatic(ymaps, map);

        // Coastal routes via Yandex route construction, polyline fallback.
        buildRoutes(ymaps, map, (label) => { if (!cancelled) setRouteNote(label); });

        // Dynamic collection for bikes/parkings/ride (re-rendered on data change).
        const collection = new ymaps.GeoObjectCollection();
        map.geoObjects.add(collection);
        overlaysRef.current = collection;
        setFailed(false);
        renderDynamic();

        cleanup = () => {
          try { map.destroy(); } catch { /* ignore */ }
        };
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      cleanup?.();
      mapRef.current = null;
      overlaysRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render dynamic overlays whenever data or selection changes.
  useEffect(() => {
    renderDynamic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bikes, parkings, ride, selectedBikeId, interactive]);

  function renderDynamic() {
    const ymaps = ymapsRef.current;
    const collection = overlaysRef.current;
    if (!ymaps || !collection) return;
    collection.removeAll();

    // Parkings — mapped from abstract storage to real coordinates near towns.
    for (const p of parkings) {
      const placemark = new ymaps.Placemark(
        mapToReal(p.lng, p.lat),
        { hintContent: p.name, balloonContent: `${p.name} · ${p.occupied}/${p.capacity}` },
        {
          preset: "islands#blueParkingIcon",
          iconColor: SEA,
        },
      );
      placemark.options.set("zIndex", 200);
      collection.add(placemark);
    }

    // Bikes
    for (const b of bikes) {
      const isSel = b.id === selectedBikeId;
      const placemark = new ymaps.Placemark(
        mapToReal(b.lng, b.lat),
        {
          hintContent: `${b.id} · ${b.model}`,
          balloonContent: `${b.id} · ${b.model} · ${b.battery}%`,
        },
        {
          preset: "islands#circleIcon",
          iconColor: bikeColor(b.status),
          zIndex: isSel ? 500 : 300,
        },
      );
      if (interactive) {
        placemark.events.add("click", () => onSelectRef.current?.(b.id));
      }
      collection.add(placemark);
    }

    // Active ride track
    if (ride) {
      try {
        const pts = JSON.parse(ride.track) as [number, number, number][];
        const coords = pts.map(([x, y]) => mapToReal(x, y));
        if (coords.length > 1) {
          const line = new ymaps.Polyline(coords, {}, {
            strokeColor: SEA, strokeWidth: 4, strokeOpacity: 0.9, zIndex: 400,
          });
          collection.add(line);
        }
      } catch { /* ignore malformed track */ }
    }
  }

  if (failed) {
    return <CoastMap {...props} />;
  }

  return (
    <div
      className="relative w-full overflow-hidden rounded-xl border border-card-border bg-card"
      style={{ height }}
      data-testid="map-yandex"
    >
      <div ref={containerRef} className="w-full h-full" data-testid="map-yandex-canvas" />
      {routeNote && (
        <div
          className="absolute bottom-2 left-2 right-2 sm:right-auto sm:max-w-md rounded-md bg-background/90 backdrop-blur px-3 py-2 text-[11px] leading-snug text-muted-foreground shadow"
          data-testid="map-route-note"
        >
          Маршрут построен как MVP-превью по доступному типу маршрутизации
          Яндекс.Карт ({routeNote}). Велосипедный профиль в API v2.1 недоступен.
        </div>
      )}
    </div>
  );
}

function drawStatic(ymaps: any, map: any) {
  // Zones (operating / slow / forbidden) as real-coordinate polygons.
  for (const z of REAL_ZONES) {
    const style = zoneStyle(z.kind);
    const polygon = new ymaps.Polygon([z.polygon], { hintContent: z.name }, {
      fillColor: style.fill,
      strokeColor: style.stroke,
      strokeWidth: z.kind === "operating" ? 2 : 1.5,
      strokeStyle: z.kind === "slow" ? "shortdash" : "solid",
      zIndex: z.kind === "operating" ? 10 : 20,
    });
    map.geoObjects.add(polygon);
  }

  // Town labels — real coordinates.
  const townNames: Record<string, string> = {
    svetlogorsk: "Светлогорск",
    pionersky: "Пионерский",
    zelenogradsk: "Зеленоградск",
  };
  for (const [id, coords] of Object.entries(REAL_TOWNS)) {
    map.geoObjects.add(new ymaps.Placemark([...coords], {
      iconContent: townNames[id] ?? id,
      hintContent: townNames[id] ?? id,
    }, {
      preset: "islands#tealStretchyIcon",
      zIndex: 150,
    }));
  }
}

// Draw the encoded fallback polylines (used if Yandex route construction is
// unavailable or fails). Real [lat, lng] geometry — no affine transform.
function drawFallbackPolylines(ymaps: any, map: any) {
  for (const r of COAST_ROUTES) {
    map.geoObjects.add(new ymaps.Polyline(r.path, {}, {
      strokeColor: FOAM, strokeWidth: 9, strokeOpacity: 0.9, zIndex: 90,
    }));
    map.geoObjects.add(new ymaps.Polyline(r.path, {
      hintContent: `${r.name} · ${r.distanceKm} км · ~${r.minutes} мин`,
      balloonContent: `<b>${r.name}</b><br>${r.distanceKm} км · ~${r.minutes} мин`,
    }, {
      strokeColor: r.color, strokeWidth: 5, strokeOpacity: 1, zIndex: 100,
    }));
  }
}

// Build coastal routes between the three towns using Yandex multiRouter.
// v2.1 has no bicycle profile, so we try pedestrian → auto → masstransit and
// report the mode used (so the UI can flag it as an MVP preview). If every
// routing mode fails, we fall back to the hand-encoded coastal polylines.
function buildRoutes(
  ymaps: any,
  map: any,
  onFallbackMode: (label: string) => void,
) {
  if (!ymaps.multiRouter || !ymaps.multiRouter.MultiRoute) {
    drawFallbackPolylines(ymaps, map);
    onFallbackMode("без маршрутизатора — резервная линия");
    return;
  }

  const referencePoints = ROUTE_WAYPOINTS.map((p) => [p[0], p[1]]);

  const tryMode = (idx: number) => {
    if (idx >= ROUTE_MODES.length) {
      drawFallbackPolylines(ymaps, map);
      onFallbackMode("резервная линия");
      return;
    }
    const mode = ROUTE_MODES[idx];
    let settled = false;

    let multiRoute: any;
    try {
      multiRoute = new ymaps.multiRouter.MultiRoute(
        {
          referencePoints,
          params: { routingMode: mode.type, results: 1 },
        },
        {
          boundsAutoApply: false,
          wayPointVisible: false,
          routeActiveStrokeColor: SEA,
          routeActiveStrokeWidth: 5,
          routeStrokeColor: "rgba(29,111,142,0.5)",
          routeStrokeWidth: 3,
          zIndex: 100,
        },
      );
    } catch {
      tryMode(idx + 1);
      return;
    }

    multiRoute.model.events.add("requestsuccess", () => {
      if (settled) return;
      const routes = multiRoute.getRoutes();
      if (routes && routes.getLength && routes.getLength() > 0) {
        settled = true;
        map.geoObjects.add(multiRoute);
        // Pedestrian routing is the closest available proxy for cycling.
        onFallbackMode(mode.label);
      } else {
        tryMode(idx + 1);
      }
    });
    multiRoute.model.events.add("requestfail", () => {
      if (settled) return;
      settled = true;
      tryMode(idx + 1);
    });
  };

  tryMode(0);
}

import { useEffect, useRef, useState } from "react";
import type { Bike, Parking, ZoneRow, Ride } from "@shared/schema";
import { ROUTES, TOWNS, REAL_CENTER, svgToLatLng } from "@shared/geo";
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
const ROUTE = "#1f9e93";

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

        // Static overlays (zones, routes, towns) drawn once.
        drawStatic(ymaps, map, zones);

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

    // Parkings
    for (const p of parkings) {
      const [lat, lng] = svgToLatLng(p.lng, p.lat);
      const placemark = new ymaps.Placemark(
        [lat, lng],
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
      const [lat, lng] = svgToLatLng(b.lng, b.lat);
      const isSel = b.id === selectedBikeId;
      const placemark = new ymaps.Placemark(
        [lat, lng],
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
        const coords = pts.map(([x, y]) => svgToLatLng(x, y));
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
    </div>
  );
}

function drawStatic(ymaps: any, map: any, zones: ZoneRow[]) {
  // Zones (operating / slow / forbidden) as polygons.
  for (const z of zones) {
    let pts: [number, number][];
    try { pts = JSON.parse(z.polygon) as [number, number][]; } catch { continue; }
    const coords = pts.map(([x, y]) => svgToLatLng(x, y));
    const style = zoneStyle(z.kind);
    const polygon = new ymaps.Polygon([coords], { hintContent: z.name }, {
      fillColor: style.fill,
      strokeColor: style.stroke,
      strokeWidth: z.kind === "operating" ? 2 : 1.5,
      strokeStyle: z.kind === "slow" ? "shortdash" : "solid",
      zIndex: z.kind === "operating" ? 10 : 20,
    });
    map.geoObjects.add(polygon);
  }

  // Cycling routes — prominent teal polylines connecting the towns.
  for (const r of ROUTES) {
    const coords = r.points.map(([x, y]) => svgToLatLng(x, y));
    // casing
    map.geoObjects.add(new ymaps.Polyline(coords, {}, {
      strokeColor: FOAM, strokeWidth: 9, strokeOpacity: 0.9, zIndex: 90,
    }));
    map.geoObjects.add(new ymaps.Polyline(coords, {
      hintContent: `${r.name} · ${r.distanceKm} км`,
    }, {
      strokeColor: ROUTE, strokeWidth: 5, strokeOpacity: 1, zIndex: 100,
    }));
  }

  // Town labels — always shown on the real map; the three towns read clearly.
  for (const t of TOWNS) {
    const [lat, lng] = svgToLatLng(t.x, t.y);
    map.geoObjects.add(new ymaps.Placemark([lat, lng], {
      iconContent: t.name,
      hintContent: t.name,
    }, {
      preset: "islands#tealStretchyIcon",
      zIndex: 150,
    }));
  }
}

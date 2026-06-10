import { useEffect, useRef, useState } from "react";
import type { Bike, Parking, ZoneRow, Ride, MapObject } from "@shared/schema";
import { REAL_CENTER, mapToReal } from "@shared/geo";
import { CoastMap } from "./CoastMap";

interface Props {
  bikes?: Bike[];
  parkings?: Parking[];
  zones?: ZoneRow[];
  ride?: Ride | null;
  /** Operator-drawn routes/zones from the visual map editor. Empty by default
   *  (no pre-drawn overlays) — the public map is just the base map until an
   *  operator saves objects in /admin/map. */
  mapObjects?: MapObject[];
  selectedBikeId?: string | null;
  onSelectBike?: (id: string) => void;
  height?: number | string;
  showLabels?: boolean;
  interactive?: boolean;
  liveLocation?: { x: number; y: number } | null;
  /** When the user clicks the map, receive [lat, lng]. Enables editor mode. */
  onMapClick?: (coords: [number, number]) => void;
  /** Receives a function that returns the current map center as [lat, lng].
   *  Lets the editor add a point at the map center without a map click. */
  onCenterGetter?: (getCenter: () => [number, number]) => void;
}

// Resolved brand-ish colors (Yandex overlays can't read CSS variables).
const SEA = "#1d6f8e";

function bikeColor(status: string) {
  switch (status) {
    case "available": return "#26a884";
    case "rented": return SEA;
    case "maintenance": return "#d64545";
    case "reserved": return "#e0972a";
    default: return "#8a8f96";
  }
}

/** Fill colour for a saved zone polygon, derived from its stroke colour. */
function fillFromColor(color: string) {
  return `${color}22`; // ~13% alpha
}

export function YandexMap(props: Props) {
  const {
    bikes = [], parkings = [], ride = null, mapObjects = [],
    selectedBikeId, onSelectBike, height = 520,
    interactive = true, onMapClick, onCenterGetter,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const ymapsRef = useRef<any>(null);
  const overlaysRef = useRef<any | null>(null);      // dynamic bikes/parkings/ride
  const savedObjectsRef = useRef<any | null>(null);  // operator-drawn objects
  const onSelectRef = useRef(onSelectBike);
  onSelectRef.current = onSelectBike;
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const onCenterGetterRef = useRef(onCenterGetter);
  onCenterGetterRef.current = onCenterGetter;

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
            controls: [],
          },
          { suppressMapOpenBlock: true },
        );
        if (interactive) {
          map.controls.add("geolocationControl", {
            float: "none",
            position: { bottom: 16, right: 16 },
          });
        }
        if (!interactive) {
          map.behaviors.disable(["scrollZoom", "drag", "dblClickZoom", "multiTouch"]);
        }
        mapRef.current = map;

        // Collection for operator-drawn objects (rendered from saved data only).
        const saved = new ymaps.GeoObjectCollection();
        map.geoObjects.add(saved);
        savedObjectsRef.current = saved;

        // Dynamic collection for bikes/parkings/ride.
        const collection = new ymaps.GeoObjectCollection();
        map.geoObjects.add(collection);
        overlaysRef.current = collection;

        map.events.add("click", (e: any) => {
          const coords = e.get("coords") as [number, number];
          onMapClickRef.current?.(coords);
        });

        onCenterGetterRef.current?.(() => map.getCenter() as [number, number]);

        setFailed(false);
        renderSavedObjects();
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
      savedObjectsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render dynamic overlays whenever data or selection changes.
  useEffect(() => {
    renderDynamic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bikes, parkings, ride, selectedBikeId, interactive]);

  // Re-render saved operator objects whenever they change.
  useEffect(() => {
    renderSavedObjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapObjects]);

  function renderSavedObjects() {
    const ymaps = ymapsRef.current;
    const saved = savedObjectsRef.current;
    if (!ymaps || !saved) return;
    saved.removeAll();

    for (const obj of mapObjects) {
      let pts: [number, number][];
      try {
        pts = JSON.parse(obj.points) as [number, number][];
      } catch {
        continue;
      }
      if (!Array.isArray(pts) || pts.length < 2) continue;

      if (obj.kind === "zone") {
        const polygon = new ymaps.Polygon([pts], { hintContent: obj.name }, {
          fillColor: fillFromColor(obj.color),
          strokeColor: obj.color,
          strokeWidth: 2,
          zIndex: 20,
        });
        saved.add(polygon);
      } else {
        const line = new ymaps.Polyline(pts, {
          hintContent: obj.name,
        }, {
          strokeColor: obj.color,
          strokeWidth: 5,
          strokeOpacity: 0.95,
          zIndex: 100,
        });
        saved.add(line);
      }
    }
  }

  function renderDynamic() {
    const ymaps = ymapsRef.current;
    const collection = overlaysRef.current;
    if (!ymaps || !collection) return;
    collection.removeAll();

    // Parkings — mapped from abstract storage to real coordinates near towns.
    // Inactive points are dimmed (grey) so admin management can show the full
    // set; the public map only ever receives active parkings.
    for (const p of parkings) {
      const inactive = p.status === "inactive";
      const placemark = new ymaps.Placemark(
        mapToReal(p.lng, p.lat),
        {
          hintContent: inactive ? `${p.name} · неактивна` : p.name,
          balloonContent: `${p.name} · ${p.occupied}/${p.capacity}${inactive ? " · неактивна" : ""}`,
        },
        {
          preset: "islands#blueParkingIcon",
          iconColor: inactive ? "#8a8f96" : SEA,
        },
      );
      placemark.options.set("zIndex", inactive ? 150 : 200);
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
    </div>
  );
}

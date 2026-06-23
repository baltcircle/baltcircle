import { useEffect, useRef, useState } from "react";
import type { Bike, Parking, ZoneRow, Ride, MapObject, Ticket } from "@shared/schema";
import { REAL_CENTER, mapToReal } from "@shared/geo";
import { parkingPlacemarkStyle, PARKING_SEA } from "@shared/parkingMarker";
import { CoastMap } from "./CoastMap";

/** Which optional overlay layers are drawn. Every flag defaults to visible, so
 *  existing callers (customer map, parking/map editors) are unaffected. The
 *  admin operations map flips these from its layer toggles. */
export interface MapLayers {
  parkings?: boolean;
  bikes?: boolean;
  rides?: boolean;
  tickets?: boolean;
  objects?: boolean;
}

interface Props {
  bikes?: Bike[];
  parkings?: Parking[];
  zones?: ZoneRow[];
  ride?: Ride | null;
  /** Active rides drawn as markers (start point) plus their track. Used by the
   *  admin operations map; the customer map uses the single `ride` track. */
  activeRides?: Ride[];
  /** Open/high-priority service tickets, drawn at their bike's position. */
  tickets?: Ticket[];
  /** Operator-drawn routes/zones from the visual map editor. Empty by default
   *  (no pre-drawn overlays) — the public map is just the base map until an
   *  operator saves objects in /admin/map. */
  mapObjects?: MapObject[];
  /** Per-layer visibility. Omitted layers render as before (visible). */
  layers?: MapLayers;
  selectedBikeId?: string | null;
  onSelectBike?: (id: string) => void;
  onSelectParking?: (id: string) => void;
  onSelectRide?: (id: number) => void;
  onSelectTicket?: (id: number) => void;
  height?: number | string;
  showLabels?: boolean;
  interactive?: boolean;
  liveLocation?: { x: number; y: number } | null;
  /** Initial/desired map center as real [lat, lng]. Defaults to REAL_CENTER.
   *  Updates pan the map (e.g. once the rider's GPS position resolves). */
  center?: [number, number] | null;
  /** When the user clicks the map, receive [lat, lng]. Enables editor mode. */
  onMapClick?: (coords: [number, number]) => void;
  /** Receives a function that returns the current map center as [lat, lng].
   *  Lets the editor add a point at the map center without a map click. */
  onCenterGetter?: (getCenter: () => [number, number]) => void;
  /** Extra CSS classes for the root container div. Defaults to the card-style wrapper. */
  className?: string;
}

// Resolved brand-ish colors (Yandex overlays can't read CSS variables).
const SEA = PARKING_SEA;

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

// Service ticket marker colour by priority — critical/high stand out in red,
// the rest in amber. Used only by the admin operations map.
function ticketColor(priority: string) {
  return priority === "critical" || priority === "high" ? "#d64545" : "#e0972a";
}

export function YandexMap(props: Props) {
  const {
    bikes = [], parkings = [], ride = null, activeRides = [], tickets = [],
    mapObjects = [], layers = {},
    selectedBikeId, onSelectBike, onSelectParking, onSelectRide, onSelectTicket,
    height = 520, interactive = true, onMapClick, onCenterGetter, center = null,
    className,
  } = props;

  // A layer renders unless its flag is explicitly false (default: visible).
  const show = {
    parkings: layers.parkings !== false,
    bikes: layers.bikes !== false,
    rides: layers.rides !== false,
    tickets: layers.tickets !== false,
    objects: layers.objects !== false,
  };

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const ymapsRef = useRef<any>(null);
  const overlaysRef = useRef<any | null>(null);      // dynamic bikes/parkings/ride
  const savedObjectsRef = useRef<any | null>(null);  // operator-drawn objects
  const onSelectRef = useRef(onSelectBike);
  onSelectRef.current = onSelectBike;
  const onSelectParkingRef = useRef(onSelectParking);
  onSelectParkingRef.current = onSelectParking;
  const onSelectRideRef = useRef(onSelectRide);
  onSelectRideRef.current = onSelectRide;
  const onSelectTicketRef = useRef(onSelectTicket);
  onSelectTicketRef.current = onSelectTicket;
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;
  const onCenterGetterRef = useRef(onCenterGetter);
  onCenterGetterRef.current = onCenterGetter;

  const [failed, setFailed] = useState(false);
  // Flips to true once the map instance and its overlay collections exist.
  // The overlay-render effects below key on this so they (re)draw with the
  // *current* data once the map is ready — otherwise async data that resolves
  // before map init would render into empty closures and the overlays would
  // stay blank until an unrelated re-render (e.g. navigating away and back).
  const [ready, setReady] = useState(false);

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
            center: center ?? REAL_CENTER,
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

        // The container may have been laid out (or resized) while the API was
        // still loading; nudge the map to match its current box so tiles and
        // overlays are placed against the right viewport on first paint.
        try { map.container.fitToViewport(); } catch { /* ignore */ }

        setFailed(false);
        // Marking ready re-runs the overlay effects with current data; no need
        // to render here with the (possibly stale) init-time closures.
        setReady(true);

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
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render dynamic overlays whenever the map becomes ready or data/selection
  // changes. Keying on `ready` closes the first-load race where data resolves
  // before the map instance exists.
  useEffect(() => {
    renderDynamic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bikes, parkings, ride, activeRides, tickets, selectedBikeId, interactive,
      show.parkings, show.bikes, show.rides, show.tickets]);

  // Re-render saved operator objects whenever the map becomes ready or they change.
  useEffect(() => {
    renderSavedObjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mapObjects, show.objects]);

  // Pan to the desired center once the map is ready and whenever it changes
  // (e.g. the rider's GPS position resolves after init).
  useEffect(() => {
    if (!ready || !center || !mapRef.current) return;
    try { mapRef.current.setCenter(center); } catch { /* ignore */ }
  }, [ready, center]);

  function renderSavedObjects() {
    const ymaps = ymapsRef.current;
    const saved = savedObjectsRef.current;
    if (!ymaps || !saved) return;
    saved.removeAll();
    if (!show.objects) return;

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
    //
    // Active points use the blue parking glyph. Inactive points must use a
    // *colorable* preset: the parking presets (islands#blueParkingIcon) ship a
    // fixed-colour image and silently ignore `iconColor`, so an inactive point
    // styled that way renders identical to an active one and looks "missing".
    // islands#grayStretchyIcon honours both iconColor and a caption, giving an
    // unmistakable muted grey "P · неактивна" marker.
    if (show.parkings) {
      for (const p of parkings) {
        const inactive = p.status === "inactive";
        const style = parkingPlacemarkStyle(inactive);
        const placemark = new ymaps.Placemark(
          mapToReal(p.lng, p.lat),
          {
            iconCaption: inactive ? "P · неактивна" : undefined,
            hintContent: inactive ? `${p.name} · неактивна` : p.name,
            balloonContent: `${p.name} · ${p.occupied}/${p.capacity}${inactive ? " · неактивна" : ""}`,
          },
          {
            preset: style.preset,
            iconColor: style.iconColor,
          },
        );
        // Keep inactive markers clearly readable but visually subordinate to
        // active ones — never so faint they read as "hidden".
        placemark.options.set("zIndex", style.zIndex);
        placemark.options.set("opacity", style.opacity);
        if (interactive && onSelectParkingRef.current) {
          placemark.events.add("click", () => onSelectParkingRef.current?.(p.id));
        }
        collection.add(placemark);
      }
    }

    // Bikes
    if (show.bikes) {
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
    }

    // Single active ride track (customer map).
    if (show.rides && ride) {
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

    // Active rides as markers + tracks (admin operations map).
    if (show.rides) {
      for (const r of activeRides) {
        try {
          const pts = JSON.parse(r.track) as [number, number, number][];
          const coords = pts.map(([x, y]) => mapToReal(x, y));
          if (coords.length > 1) {
            const line = new ymaps.Polyline(coords, {}, {
              strokeColor: SEA, strokeWidth: 4, strokeOpacity: 0.85, zIndex: 380,
            });
            collection.add(line);
          }
        } catch { /* ignore malformed track */ }
        const marker = new ymaps.Placemark(
          mapToReal(r.startLng, r.startLat),
          {
            hintContent: `Поездка #${r.id} · ${r.bikeId}`,
            balloonContent: `Поездка #${r.id} · велосипед ${r.bikeId}`,
          },
          { preset: "islands#nightCircleDotIcon", iconColor: SEA, zIndex: 420 },
        );
        if (interactive && onSelectRideRef.current) {
          marker.events.add("click", () => onSelectRideRef.current?.(r.id));
        }
        collection.add(marker);
      }
    }

    // Open / high-priority service tickets at their bike's position.
    if (show.tickets) {
      const bikeById = new Map(bikes.map((b) => [b.id, b] as const));
      for (const t of tickets) {
        const bike = bikeById.get(t.bikeId);
        if (!bike) continue; // no position to anchor the marker without the bike
        const marker = new ymaps.Placemark(
          mapToReal(bike.lng, bike.lat),
          {
            hintContent: `Тикет #${t.id} · ${t.bikeId} · ${t.priority}`,
            balloonContent: `Тикет #${t.id} · ${t.bikeId} · ${t.title || t.kind}`,
          },
          { preset: "islands#dotIcon", iconColor: ticketColor(t.priority), zIndex: 460 },
        );
        if (interactive && onSelectTicketRef.current) {
          marker.events.add("click", () => onSelectTicketRef.current?.(t.id));
        }
        collection.add(marker);
      }
    }
  }

  if (failed) {
    return <CoastMap {...props} />;
  }

  return (
    <div
      className={className ?? "relative w-full overflow-hidden rounded-xl border border-card-border bg-card"}
      style={{ height }}
      data-testid="map-yandex"
    >
      <div ref={containerRef} className="w-full h-full" data-testid="map-yandex-canvas" />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Bike, MapObject, Parking, Ride, Ticket } from "@shared/schema";
import { mapToReal } from "@shared/geo";
import {
  ensurePMTilesProtocol, MARKER_COLORS, MAX_BOUNDS,
  PMTILES_URL, DEFAULT_CENTER, DEFAULT_ZOOM, buildStyle,
} from "./map/mapStyle";
import {
  bikeMarkerColor, ticketMarkerColor, dotMarkerEl, parkingMarkerEl,
  fillFromColor, coercePoints, smoothCorners, catmullRomSmooth,
} from "./map/mapMarkers";
import { createGeoFilter, douglasPeucker } from "@/lib/geoSmoothing";

/** Which optional overlay layers are drawn. Every flag defaults to visible so
 *  the customer map and editors are unaffected; the admin operations map flips
 *  these from its layer toggles. Mirrors the old YandexMap MapLayers contract. */
export interface MapLayers {
  parkings?: boolean;
  bikes?: boolean;
  rides?: boolean;
  tickets?: boolean;
  objects?: boolean;
}

interface MapLibreMapProps {
  parkings?: Parking[];
  mapObjects?: MapObject[];
  ride?: Ride | null;
  /** Fleet bikes drawn as coloured dots (admin operations map). */
  bikes?: Bike[];
  /** Active rides drawn as start markers + track lines (admin operations map). */
  activeRides?: Ride[];
  /** Open service tickets, drawn at their bike's position (admin operations map). */
  tickets?: Ticket[];
  /** Per-layer visibility. Omitted layers render as before (visible). */
  layers?: MapLayers;
  selectedBikeId?: string | null;
  onSelectBike?: (id: string) => void;
  onSelectParking?: (id: string) => void;
  onSelectRide?: (id: number) => void;
  onSelectTicket?: (id: number) => void;
  /** Disables map gestures when false (static preview). */
  interactive?: boolean;
  /** Map click returns [lat, lng] — enables the editor draw mode. */
  onMapClick?: (coords: [number, number]) => void;
  /** Receives a getter for the current map centre as [lat, lng] (editor). */
  onCenterGetter?: (getCenter: () => [number, number]) => void;
  /**
   * Live draft для редактора карты. Точки — [lat, lng]. Отрисуется как
   * полупрозрачная линия/полигон + вершины-маркеры с номерами. Клик по вершине
   * вызывает onVertexClick(index). Клик по первой вершине для zone удобно
   * трактовать как «замкнуть» на уровне вызывающего кода.
   */
  editorDraft?: {
    points: [number, number][];
    kind: "route" | "zone";
    color: string;
    onVertexClick?: (index: number) => void;
    /** Перетаскивание вершины. coords — [lat, lng]. */
    onVertexDrag?: (index: number, coords: [number, number]) => void;
  } | null;
  height?: string;
  showLabels?: boolean;
  center?: [number, number] | null;
  /**
   * Слежение за GPS-точкой в режиме активной аренды. Когда true —
   * карта автоматически выравнивается по user location при каждом GPS update.
   */
  followUser?: boolean;
  /**
   * Каллбэк на каждый GPS update. Используется внешними компонентами
   * (напр. трекер активной аренды) чтобы не дублировать watchPosition.
   */
  onUserLocation?: (lat: number, lng: number, headingDeg: number | null) => void;
  className?: string;
}

// ── COMPONENT ─────────────────────────────────────────────────────────────────
export function MapLibreMap({
  parkings = [], mapObjects = [], ride = null,
  bikes = [], activeRides = [], tickets = [], layers = {},
  selectedBikeId, onSelectBike, onSelectParking, onSelectRide, onSelectTicket,
  interactive = true, onMapClick, onCenterGetter, followUser, onUserLocation,
  editorDraft = null,
  height = "100%", showLabels = false, center, className,
}: MapLibreMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<any>(null);
  // HTML markers (bikes/parkings/ride starts/tickets) are managed imperatively;
  // routes/zones/tracks go through GeoJSON sources. Kept in a ref so the render
  // effect can clear the previous batch before drawing the next.
  const markersRef   = useRef<maplibregl.Marker[]>([]);
  // Editor draft vertices — отдельный пул, чтобы не дёргать основной слой
  // маркеров при каждом добавлении точки.
  const draftMarkersRef = useRef<maplibregl.Marker[]>([]);
  // Signals the overlay effects that the map instance + sources exist. Data that
  // resolves before map init would otherwise render into a null map and stay blank.
  const readyRef     = useRef(false);
  const [ready, setReady] = useState(false);

  // Latest callbacks kept in refs so the one-time init effect always calls the
  // current handler without re-subscribing map events on every render.
  const onMapClickRef      = useRef(onMapClick);      onMapClickRef.current = onMapClick;
  const onCenterGetterRef  = useRef(onCenterGetter);  onCenterGetterRef.current = onCenterGetter;
  const followUserRef      = useRef(followUser);      followUserRef.current      = followUser;
  const onUserLocationRef  = useRef(onUserLocation);  onUserLocationRef.current  = onUserLocation;
  // Кэш последней GPS-точки — нужен чтобы при включении followUser мгновенно
  // перелететь к точке, а не ждать следующего watchPosition tick (может быть 5-15 сек).
  const lastUserPosRef     = useRef<{ lng: number; lat: number } | null>(null);
  const onSelectBikeRef    = useRef(onSelectBike);    onSelectBikeRef.current = onSelectBike;
  const onSelectParkingRef = useRef(onSelectParking); onSelectParkingRef.current = onSelectParking;
  const onSelectRideRef    = useRef(onSelectRide);    onSelectRideRef.current = onSelectRide;
  const onSelectTicketRef  = useRef(onSelectTicket);  onSelectTicketRef.current = onSelectTicket;

  // A layer renders unless its flag is explicitly false (default: visible).
  const show = {
    parkings: layers.parkings !== false,
    bikes:    layers.bikes    !== false,
    rides:    layers.rides    !== false,
    tickets:  layers.tickets  !== false,
    objects:  layers.objects  !== false,
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;

    const initMap = (
      tileSource: { type: "pmtiles"; url: string } | { type: "xyz"; url: string },
      minzoom: number,
      maxzoom: number
    ) => {
      if (cancelled || mapRef.current) return;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return; // wait for a real size (ResizeObserver retries)
      const map = new maplibregl.Map({
        container: el,
        style: buildStyle(tileSource, minzoom, maxzoom) as any,
        center: center ? [center[1], center[0]] : DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        maxBounds: MAX_BOUNDS,
        attributionControl: false,
        trackResize: true,
        interactive,
      });
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      // Static previews (interactive=false): also hard-disable gestures so a
      // wrapping scroll container isn't hijacked by the map.
      if (!interactive) {
        map.scrollZoom.disable();
        map.dragPan.disable();
        map.doubleClickZoom.disable();
        map.touchZoomRotate.disable();
        map.keyboard.disable();
      }
      // Map clicks feed the editor draw mode with real [lat, lng].
      map.on("click", (e: maplibregl.MapMouseEvent) => {
        onMapClickRef.current?.([e.lngLat.lat, e.lngLat.lng]);
      });
      map.once("load", () => {
        map.resize();
        readyRef.current = true;
        // Сектор-конус направления движения (стиль Google Maps «луч фонарика»).
        // Вершина конуса — в самой GPS-точке, веер расходится в сторону heading
        // с плавным градиентом: насыщенный брендовый #61B5C4 у вершины → полностью
        // прозрачный на внешней дуге. Рисуем «вверх» (0° = север); MapLibre крутит
        // по icon-rotate. icon-anchor:bottom → вершина конуса привязана к точке,
        // поворот идёт вокруг неё. Рендер в 2× (pixelRatio) для чёткости на retina.
        if (!map.hasImage("user-heading-cone")) {
          const S = 120;          // логический размер стороны
          const dpr = 2;
          const c = document.createElement("canvas");
          c.width = S * dpr; c.height = S * dpr;
          const ctx = c.getContext("2d")!;
          ctx.scale(dpr, dpr);
          const apexX = S / 2, apexY = S;      // вершина — центр нижней грани
          const R = S * 0.94;                  // длина луча
          const half = (75 / 2) * Math.PI / 180; // раствор ~75°
          const up = -Math.PI / 2;
          const grad = ctx.createRadialGradient(apexX, apexY, 0, apexX, apexY, R);
          grad.addColorStop(0.0, "rgba(97,181,196,0.55)"); // #61B5C4 у точки
          grad.addColorStop(0.55, "rgba(97,181,196,0.22)");
          grad.addColorStop(1.0, "rgba(97,181,196,0.0)");  // прозрачный край
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(apexX, apexY);
          ctx.arc(apexX, apexY, R, up - half, up + half);
          ctx.closePath();
          ctx.fill();
          const img = ctx.getImageData(0, 0, S * dpr, S * dpr);
          map.addImage(
            "user-heading-cone",
            { width: S * dpr, height: S * dpr, data: new Uint8Array(img.data.buffer) },
            { pixelRatio: dpr },
          );
        }
        // Hand the editor a getter for the live centre as [lat, lng].
        onCenterGetterRef.current?.(() => {
          const c = map.getCenter();
          return [c.lat, c.lng] as [number, number];
        });
        if (!cancelled) setReady(true);
      });
      mapRef.current = map;
    };

    const initXYZ = async () => {
      if (cancelled || mapRef.current) return;
      const origin = window.location.origin;
      try {
        const j = await fetch(`${origin}/tiles/data/kaliningrad.json`)
          .then(r => r.json()) as { tiles?: string[]; minzoom?: number; maxzoom?: number };
        if (cancelled) return;
        const rawTiles: string[] = Array.isArray(j.tiles) ? j.tiles : [];
        const tileUrl = rawTiles.map((u: string) =>
          u.startsWith("http") ? u : `${origin}${u.startsWith("/") ? "" : "/"}${u}`
        )[0] ?? `${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf`;
        initMap({ type: "xyz", url: tileUrl }, j.minzoom ?? 0, j.maxzoom ?? 14);
      } catch {
        if (!cancelled) initMap({ type: "xyz", url: `${origin}/tiles/data/kaliningrad/{z}/{x}/{y}.pbf` }, 0, 14);
      }
    };

    // maplibre + pmtiles are bundled (Vite emits the worker same-origin), so we
    // just register the pmtiles protocol and build the map. No async loading, no
    // worker-URL race, no cross-origin Worker restriction. The `earth` layer is
    // rendered on top of the water background, fixing the ocean-flood bug.
    const boot = () => {
      if (cancelled || mapRef.current) return;
      const { width, height: h } = el.getBoundingClientRect();
      if (width === 0 || h === 0) return; // ResizeObserver retries once sized
      ensurePMTilesProtocol();
      // If the pmtiles file is missing (e.g. first deploy before CI), fall back
      // to the legacy XYZ proxy. We optimistically try pmtiles first.
      try {
        initMap({ type: "pmtiles", url: PMTILES_URL }, 0, 14);
      } catch {
        void initXYZ();
      }
    };

    const ro = new ResizeObserver(() => {
      if (mapRef.current) mapRef.current.resize();
      else boot();
    });
    ro.observe(el);

    boot();

    return () => {
      cancelled = true;
      ro.disconnect();
      readyRef.current = false;
      for (const m of markersRef.current) { try { m.remove(); } catch { /* ignore */ } }
      markersRef.current = [];
      for (const m of draftMarkersRef.current) { try { m.remove(); } catch { /* ignore */ } }
      draftMarkersRef.current = [];
      try { mapRef.current?.remove(); } catch { /* ignore */ }
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center[1], center[0]], zoom: 14, duration: 1000 });
  }, [center]);

  // ── GEOLOCATION: watchPosition → update "user-location" source ───────────────
  // Подписываемся один раз при mount (когда карта готова). Не требуем сразу —
  // карта всё ещё рендерится без точки, и как только браузер выдаст первую точку — она
  // появится. При deny/failure просто не рисуем — карта работает без неё.
  useEffect(() => {
    if (!ready) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const map = mapRef.current;
    if (!map) return;

    // Фильтр качества GPS: режет неточные точки (accuracy > 50 м), «телепорты»
    // (скорость между точками > 60 км/ч — нереально для велосипеда) и сглаживает
    // джиттер адаптивным EMA. Логика/тесты — client/src/lib/geoSmoothing.ts.
    const geo = createGeoFilter();
    // heading от GPS приходит только когда юзер двигается (в стоячем положении = null/NaN).
    // Фильтр держит последнее валидное значение — стрелка/сектор не обнуляются на остановке.
    let lastHeading: number | null = null;

    const updateSource = (lng: number, lat: number, heading: number | null) => {
      const src = map.getSource("user-location");
      if (!src) return;
      if (heading !== null) lastHeading = heading;
      src.setData({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {
            hasHeading: lastHeading !== null,
            heading: lastHeading ?? 0,
          },
          geometry: { type: "Point", coordinates: [lng, lat] },
        }],
      });
      // Кэшируем последнюю точку для мгновенного центрования при включении followUser.
      lastUserPosRef.current = { lng, lat };
      // Слежение за пользователем — мягкий easeTo (а не flyTo, чтобы карта не дёргалась).
      if (followUserRef.current) {
        map.easeTo({ center: [lng, lat], duration: 800, essential: true });
      }
      // Публикуем координаты наверх — трекер активной аренды подпишется.
      onUserLocationRef.current?.(lat, lng, lastHeading);
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const smoothed = geo.push({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading ?? null,
          timestamp: pos.timestamp ?? Date.now(),
        });
        if (!smoothed) return; // точка отброшена как выброс/шум
        updateSource(smoothed.lng, smoothed.lat, smoothed.heading);
      },
      () => { /* silent fail — no dot */ },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [ready]);

  // При включении followUser (начало аренды) — мгновенно летим к GPS-точке,
  // не дожидаясь следующего watchPosition tick.
  useEffect(() => {
    if (!ready) return;
    if (!followUser) return;
    const map = mapRef.current;
    if (!map) return;
    const p = lastUserPosRef.current;
    if (!p) return; // точка ещё не пришла — первый tick сам сцентрирует.
    map.flyTo({ center: [p.lng, p.lat], zoom: 15, duration: 800, essential: true });
  }, [followUser, ready]);

  // ── HTML markers: parkings, bikes, active-ride starts, tickets ──────────────
  // Coordinate note: bikes/parkings are stored in abstract space; mapToReal(lng,lat)
  // returns real [lat, lng], and MapLibre markers take [lng, lat] — so we swap.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    for (const m of markersRef.current) { try { m.remove(); } catch { /* ignore */ } }
    markersRef.current = [];

    const addMarker = (lngLat: [number, number], el: HTMLElement, onClick?: () => void) => {
      if (interactive && onClick) el.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
      const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
      markersRef.current.push(marker);
    };

    // Parkings
    if (show.parkings) {
      for (const p of parkings) {
        const inactive = p.status === "inactive";
        const [lat, lng] = mapToReal(p.lng, p.lat);
        const el = parkingMarkerEl(inactive, interactive && !!onSelectParkingRef.current);
        el.title = inactive ? `${p.name} · неактивна` : p.name;
        addMarker([lng, lat], el, () => onSelectParkingRef.current?.(p.id));
      }
    }

    // Bikes
    if (show.bikes) {
      for (const b of bikes) {
        const isSel = b.id === selectedBikeId;
        const [lat, lng] = mapToReal(b.lng, b.lat);
        const el = dotMarkerEl(bikeMarkerColor(b.status), { ring: isSel, size: isSel ? 20 : 16, clickable: interactive && !!onSelectBikeRef.current });
        // Тултип на маркере без заряда замка — клиенту эта информация не нужна.
        el.title = `${b.id} · ${b.model}`;
        addMarker([lng, lat], el, () => onSelectBikeRef.current?.(b.id));
      }
    }

    // Active rides — start markers (tracks are drawn via the ride-tracks source).
    if (show.rides) {
      for (const r of activeRides) {
        const [lat, lng] = mapToReal(r.startLng, r.startLat);
        const el = dotMarkerEl(MARKER_COLORS.ride, { size: 14, clickable: interactive && !!onSelectRideRef.current });
        el.title = `Поездка #${r.id} · велосипед ${r.bikeId}`;
        addMarker([lng, lat], el, () => onSelectRideRef.current?.(r.id));
      }
    }

    // Open / high-priority tickets at their bike's position.
    if (show.tickets) {
      const bikeById = new Map(bikes.map((b) => [b.id, b] as const));
      for (const t of tickets) {
        const bike = bikeById.get(t.bikeId);
        if (!bike) continue;
        const [lat, lng] = mapToReal(bike.lng, bike.lat);
        const el = dotMarkerEl(ticketMarkerColor(t.priority), { size: 13, clickable: interactive && !!onSelectTicketRef.current });
        el.title = `Тикет #${t.id} · ${t.bikeId} · ${t.title || t.kind}`;
        addMarker([lng, lat], el, () => onSelectTicketRef.current?.(t.id));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bikes, parkings, activeRides, tickets, selectedBikeId, interactive,
      show.parkings, show.bikes, show.rides, show.tickets]);

  // ── GeoJSON overlays: operator objects (routes/zones) ───────────────────────
  // Editor points are already real [lat, lng]; GeoJSON needs [lng, lat].
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("saved-objects");
    if (!src) return;

    const features: GeoJSON.Feature[] = [];
    if (show.objects) {
      for (const obj of mapObjects) {
        const pts = coercePoints(obj.points);
        if (!Array.isArray(pts) || pts.length < 2) continue;
        const ring = pts.map(([lat, lng]) => [lng, lat]);
        const props = { kind: obj.kind, color: obj.color, fillColor: fillFromColor(obj.color), name: obj.name };
        if (obj.kind === "zone") {
          const closed = [...ring];
          const [f0, f1] = closed[0]; const [l0, l1] = closed[closed.length - 1];
          if (f0 !== l0 || f1 !== l1) closed.push(closed[0]); // GeoJSON polygons must close
          features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [closed] } });
        } else {
          // Смягчение углов: вокруг каждой вершины 2 контрольные точки,
          // line-join: round в стиле скругляет переход.
          const smooth = obj.kind === "route" ? smoothCorners(ring, 0.25, 12) : ring;
          features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: smooth } });
        }
      }
    }
    src.setData({ type: "FeatureCollection", features });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mapObjects, show.objects]);

  // ── EDITOR DRAFT: линия/полигон + вершины-маркеры ─────────────────────────
  // Точки в editorDraft хранятся как [lat, lng]; в GeoJSON идёт [lng, lat].
  // Линия/полигон рисуется через layer, вершины — через HTML-маркеры
  // (чтобы клик по ним был целью — так вызывающий код видит index вершины).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("editor-draft");
    if (!src) return;

    // 1) Линия/полигон
    const features: GeoJSON.Feature[] = [];
    const pts = editorDraft?.points ?? [];
    const color = editorDraft?.color ?? "#1d6f8e";
    const kind = editorDraft?.kind ?? "route";
    if (pts.length >= 2) {
      const ring = pts.map(([lat, lng]) => [lng, lat]);
      if (kind === "zone" && pts.length >= 3) {
        const closed = [...ring, ring[0]];
        features.push({
          type: "Feature",
          properties: { kind: "zone", color },
          geometry: { type: "Polygon", coordinates: [closed] },
        });
      }
      features.push({
        type: "Feature",
        properties: { kind, color },
        geometry: { type: "LineString", coordinates: ring },
      });
    }
    src.setData({ type: "FeatureCollection", features });

    // 2) Вершины — HTML маркеры
    for (const m of draftMarkersRef.current) { try { m.remove(); } catch { /* ignore */ } }
    draftMarkersRef.current = [];

    if (pts.length === 0) return;

    const total = pts.length;
    const isZone = kind === "zone";
    pts.forEach((p, i) => {
      const [lat, lng] = p;
      const isFirst = i === 0;
      const isLast = i === total - 1;
      // Важно: MapLibre ставит transform на сам элемент маркера (translate
      // для позиционирования). Любые свои анимации/scale — только на вложенном child,
      // иначе keyframe перезапишет координатный transform и маркер уедет в (0,0).
      const wrap = document.createElement("div");
      wrap.style.pointerEvents = "auto";
      const el = document.createElement("div");
      wrap.appendChild(el);

      const size = isFirst ? 22 : 18;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.borderRadius = "50%";
      el.style.background = isFirst ? "#ffffff" : color;
      el.style.border = isFirst ? `3px solid ${color}` : "2px solid #ffffff";
      el.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
      el.style.boxSizing = "border-box";
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.font = "600 10px/1 system-ui, sans-serif";
      el.style.color = isFirst ? color : "#ffffff";
      el.style.cursor = editorDraft?.onVertexDrag ? "grab" : (editorDraft?.onVertexClick ? "pointer" : "default");
      // Номер вершины внутри кружка.
      el.textContent = isFirst && isZone ? "◎" : String(i + 1);
      if (isFirst && isZone && total >= 3) {
        wrap.title = "Кликни чтобы замкнуть зону";
        // Анимация только на child — она не сломает координатный transform маркера.
        el.style.animation = "editor-pulse 1.5s ease-in-out infinite";
        // Кликабельная область — когда первая точка готова к замыканию, делаем
        // крупнее через прозрачный hit-area, чтобы палец точно попадал (особенно на мобилах).
        el.style.outline = `12px solid transparent`;
        el.style.outlineOffset = `0px`;
      } else if (isFirst) {
        wrap.title = "Первая точка";
      } else if (isLast) {
        wrap.title = `Точка ${i + 1} · последняя`;
      } else {
        wrap.title = `Точка ${i + 1}`;
      }
      // Drag включаем только если вызывающий код подписался на onVertexDrag.
      const marker = new maplibregl.Marker({
        element: wrap,
        draggable: !!editorDraft?.onVertexDrag,
      }).setLngLat([lng, lat]).addTo(map);

      // Флаг чтобы click не срабатывал после перетаскивания.
      let dragged = false;
      if (editorDraft?.onVertexDrag) {
        marker.on("dragstart", () => {
          dragged = true;
          el.style.animation = "none";
          el.style.transform = "scale(1.1)";
        });
        // Live-обновление GeoJSON source во время перетаскивания: точка
        // не отрывается от линии/полигона. Важно: меняем ТОЛЬКО source,
        // без вызова onVertexDrag — иначе React пересоздаст маркеры
        // через useEffect и drag прервётся.
        marker.on("drag", () => {
          const ll = marker.getLngLat();
          const dragSrc = map.getSource("editor-draft") as maplibregl.GeoJSONSource | undefined;
          if (!dragSrc) return;
          // pts — из замыкания (текущий черновик); i — индекс этой вершины.
          const nextPts: [number, number][] = pts.map((pp, idx) =>
            idx === i ? [ll.lat, ll.lng] as [number, number] : pp,
          );
          const nextFeatures: GeoJSON.Feature[] = [];
          if (nextPts.length >= 2) {
            const nextRing = nextPts.map(([la, ln]) => [ln, la]);
            if (kind === "zone" && nextPts.length >= 3) {
              nextFeatures.push({
                type: "Feature",
                properties: { kind: "zone", color },
                geometry: { type: "Polygon", coordinates: [[...nextRing, nextRing[0]]] },
              });
            }
            nextFeatures.push({
              type: "Feature",
              properties: { kind, color },
              geometry: { type: "LineString", coordinates: nextRing },
            });
          }
          dragSrc.setData({ type: "FeatureCollection", features: nextFeatures });
        });
        marker.on("dragend", () => {
          const ll = marker.getLngLat();
          el.style.transform = "";
          editorDraft.onVertexDrag!(i, [ll.lat, ll.lng]);
          // dragged флаг снимется через microtask в click-хандлере, но маркер всё равно будет
          // пересоздан useEffect'ом после апдейта points.
        });
      }

      if (editorDraft?.onVertexClick) {
        const handler = (ev: Event) => {
          ev.stopPropagation();
          if (dragged) { dragged = false; return; }
          editorDraft.onVertexClick!(i);
        };
        wrap.addEventListener("click", handler);
        wrap.addEventListener("touchend", handler, { passive: true });
      }

      draftMarkersRef.current.push(marker);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, editorDraft?.points, editorDraft?.kind, editorDraft?.color]);

  // ── GeoJSON overlays: ride tracks (customer single ride + admin active rides) ─
  // Track points are [[x, y, t], ...] in abstract space; mapToReal(x,y) → [lat,lng],
  // GeoJSON needs [lng, lat].
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("ride-tracks");
    if (!src) return;

    const features: GeoJSON.Feature[] = [];
    const addTrack = (raw: string | null | undefined) => {
      if (!raw) return;
      let pts: [number, number, number][];
      try { pts = JSON.parse(raw) as [number, number, number][]; } catch { return; }
      const coords = pts.map(([x, y]) => { const [lat, lng] = mapToReal(x, y); return [lng, lat] as [number, number]; });
      if (coords.length <= 1) return;
      // Сырой трек соединяет GPS-точки ломаной — углы и шум. Чистим в два шага:
      //  1) Дуглас-Пекер (ε≈1e-5° ≈ 1.1 м) — выкидывает избыточные точки на
      //     прямых, не искажая форму;
      //  2) Catmull-Rom — интерполирует сглаженной кривой, проходящей через
      //     оставшиеся точки. Вместе с line-join/cap:round даёт плавную линию.
      const simplified = douglasPeucker(coords, 1e-5);
      const smooth = simplified.length >= 3 ? catmullRomSmooth(simplified, 8) : simplified;
      features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: smooth } });
    };
    if (show.rides) {
      if (ride) addTrack(ride.track);
      for (const r of activeRides) addTrack(r.track);
    }
    src.setData({ type: "FeatureCollection", features });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ride, activeRides, show.rides]);

  return <div ref={containerRef} className={className} style={{ height }} />;
}
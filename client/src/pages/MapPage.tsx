import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";

import type { Bike, MapObject, Parking, Ride } from "@shared/schema";
import { MapLibreMap } from "@/components/MapLibreMap";
import { RentalStartModal } from "@/components/RentalStartModal";
import { RegistrationModal } from "@/components/RegistrationModal";
import { QrScanModal } from "@/components/QrScanModal";
import { DrawerMenu } from "@/components/DrawerMenu";
import { Logo } from "@/components/Logo";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useActiveRideStream } from "@/hooks/use-active-ride-stream";
import { useActiveRideTracker } from "@/hooks/use-active-ride-tracker";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtDuration, fmtDistance, fmtRub } from "@/lib/format";
import { PENDING_BIKE_KEY } from "@/lib/pending-bike";
import { QrCode, Lock, Clock, Menu, MapPin, Route } from "lucide-react";

const INTRO_SHOWN_KEY = "bc.registration.intro.shown";

export function MapPage() {
  const toast = useToast();
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const mapObjectsQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  const activeQ = useQuery<Ride | null>({
    queryKey: ["/api/rides/active"],
  });
  // Live active-ride updates via SSE (replaces the old 4s poll).
  useActiveRideStream();
  const { isRegistered, isLoading: userLoading } = useCurrentUser();

  const activeRide = activeQ.data ?? null;

  // GPS-трекер активной аренды: слушает onUserLocation от MapLibreMap и шлёт
  // точки на /api/rides/{id}/point (тротлинг 3с + фильтр GPS-дребезга <5м).
  const rideTracker = useActiveRideTracker(activeRide);

  const [selected, setSelected] = useState<string | null>(null);

  const bike = useMemo(
    () => bikesQ.data?.find(b => b.id === selected) ?? null,
    [selected, bikesQ.data]
  );

  const availableBikes = useMemo(
    () => bikesQ.data?.filter(b => b.status === "available") ?? [],
    [bikesQ.data]
  );

  useEffect(() => {
    if (!selected && availableBikes[0]) setSelected(availableBikes[0].id);
  }, [availableBikes, selected]);

  const [rentalOpen, setRentalOpen] = useState(false);
  const [rentalMulti, setRentalMulti] = useState(false);
  const [regOpen, setRegOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Geolocation: center map on user position.
  // Собственный watchPosition (кеширует последнюю точку) → клик по кнопке моментально
  // перелетает к ней. Каждый клик генерит новый массив — useEffect(center) в MapLibreMap
  // сработает даже если координаты не изменились.
  const [geoCenter, setGeoCenter] = useState<[number, number] | null>(null);
  const lastPosRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => { lastPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      () => { /* silent — ошибку покажем только когда юзер попробует геолокацию */ },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const handleGeolocate = () => {
    // Есть свежая точка — летим мгновенно. Новый массив каждый клик → useEffect тригерится.
    if (lastPosRef.current) {
      setGeoCenter([lastPosRef.current.lat, lastPosRef.current.lng]);
      return;
    }
    // Фоллбэк — точки ещё нет, запрашиваем явно (может вызвать prompt на iOS PWA).
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setGeoCenter([pos.coords.latitude, pos.coords.longitude]);
      },
      () => {
        toast.toast({
          title: "Геолокация недоступна",
          description: "Разрешите доступ к местоположению в настройках браузера",
          variant: "destructive",
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const pendingMulti = useRef<boolean | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activeRide) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeRide]);

  useEffect(() => {
    if (userLoading || isRegistered) return;
    if (localStorage.getItem(INTRO_SHOWN_KEY)) return;
    localStorage.setItem(INTRO_SHOWN_KEY, "1");
    setRegOpen(true);
  }, [userLoading, isRegistered]);

  const endMut = useMutation({
    mutationFn: async (rideId: number) => {
      const res = await apiRequest("POST", `/api/rides/${rideId}/end`);
      return res.json() as Promise<Ride>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rides"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      toast.toast({ title: "Поездка завершена", description: "Спасибо, что выбрали TakeRide!" });
    },
    onError: (err: any) => {
      toast.toast({
        title: "Не удалось завершить",
        description: err?.message ?? "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
  });

  const openScan = (multi: boolean) => {
    setRentalMulti(multi);
    setScanOpen(true);
  };

  const goRent = (multi = false) => {
    if (!isRegistered) {
      pendingMulti.current = multi;
      setRegOpen(true);
      return;
    }
    openScan(multi);
  };

  const onBikeScanned = (b: Bike) => {
    setSelected(b.id);
    setRentalOpen(true);
  };

  useEffect(() => {
    if (userLoading || !bikesQ.data) return;
    const code = sessionStorage.getItem(PENDING_BIKE_KEY);
    if (!code) return;
    sessionStorage.removeItem(PENDING_BIKE_KEY);

    const target = bikesQ.data.find((b) => b.id.toUpperCase() === code);
    if (!target) {
      toast.toast({ title: "Велосипед не найден", description: code, variant: "destructive" });
      return;
    }
    if (target.status !== "available") {
      toast.toast({ title: "Велосипед недоступен", description: `${target.id} сейчас занят`, variant: "destructive" });
      return;
    }
    if (!isRegistered) {
      pendingMulti.current = false;
      setRegOpen(true);
      return;
    }
    onBikeScanned(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLoading, bikesQ.data, isRegistered]);

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden" style={{height: "100%"}} data-testid="map-page">
      {/* Map — заливает весь физический экран, включая зоны safe-area
       * (status bar сверху и home-indicator снизу). Карта течёт под ними,
       * без плоских голубых полос backdrop-а. Важно: в iOS standalone (PWA)
       * контейнер должен быть привязан к физическому экрану,
       * поэтому вместо inset:0 (который в fixed-контексте ограничен visualViewport)
       * явно растягиваем через negative-margin в safe-area зоны. Кнопки
       * (лого/бургер/гео/скан) отступают от safe-area через env(). */}
      <div
        className="fixed inset-0 z-0 overflow-hidden"
        style={{
          // 100vh в iOS PWA включает зоны safe-area — это то что надо,
          // карта будет рендерить под status bar и под home-indicator.
          height: "100vh",
          width: "100vw",
        }}
      >
        <MapLibreMap
          parkings={parkingsQ.data ?? []}
          mapObjects={mapObjectsQ.data ?? []}
          ride={activeRide}
          height="100%"
          showLabels={false}
          center={geoCenter}
          followUser={!!activeRide}
          onUserLocation={(lat, lng) => {
            lastPosRef.current = { lat, lng };
            if (activeRide) rideTracker.push(lat, lng);
          }}
          className="w-full h-full"
        />
      </div>

      {/* Top bar — logo left, burger right */}
      <div
        className="absolute left-0 right-0 z-20 flex items-center justify-between px-4"
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
      >
        {/* Logo — top left. Uses the theme card surface so it follows the
         * palette (teal in light, blue in dark) instead of a white pill. */}
        <div className="rounded-2xl bg-card/90 backdrop-blur-sm shadow-lg px-3 py-2">
          <Logo className="text-card-foreground h-8" />
        </div>

        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Открыть меню"
          data-testid="home-menu-button"
          className="w-12 h-12 rounded-full bg-primary text-black shadow-lg flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* Geolocation button — bottom right, above scan button.
       * Позиционируется через fixed+bottom относительно visualViewport (без зоны URL-бара),
       * чтобы кнопка всегда была видна пользователю, а не под URL-баром. */}
      <button
        type="button"
        onClick={handleGeolocate}
        aria-label="Моё местоположение"
        data-testid="home-geolocate-button"
        className="fixed right-4 z-20 w-12 h-12 rounded-full bg-primary text-black shadow-lg flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem + 3.5rem + 1rem)" }}
      >
        <MapPin className="w-5 h-5" />
      </button>

      {/* Bottom action area — floats over the map.
       * Кнопка плавает над картой с отступом от нижнего края (учитывая safe-area),
       * карта под ней просвечивает. Пространство ниже кнопки — тоже карта (fixed inset:0). */}
      <div
        className="fixed left-4 right-4 z-40"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }}
      >
        {activeRide ? (
          /* Active ride card */
          <div
            className="rounded-2xl bg-card/95 text-card-foreground backdrop-blur-sm shadow-xl px-4 py-3"
            data-testid="home-active-ride-card"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-accent">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent ride-pulse" /> В пути
                </div>
                <div className="font-display text-base font-light leading-tight truncate" data-testid="text-active-bike">
                  {activeRide.bikeId}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Стоимость</div>
                <div className="font-display text-base font-light tabular-nums" data-testid="text-ride-cost">
                  {fmtRub(activeRide.cost ?? 0)}
                </div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-background/50 border border-card-border px-3 py-2">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                  <Clock className="w-3 h-3" /> Время
                </div>
                <div className="font-display text-base font-light tabular-nums mt-0.5" data-testid="text-ride-duration">
                  {fmtDuration(now - activeRide.startedAt)}
                </div>
              </div>
              <div className="rounded-xl bg-background/50 border border-card-border px-3 py-2">
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                  <Route className="w-3 h-3" /> Расстояние
                </div>
                <div className="font-display text-base font-light tabular-nums mt-0.5" data-testid="text-ride-distance">
                  {fmtDistance(activeRide.distanceM ?? 0)}
                </div>
              </div>
            </div>
            <div className="mt-2">
              <button
                type="button"
                onClick={() => endMut.mutate(activeRide.id)}
                disabled={endMut.isPending}
                data-testid="button-end-ride"
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand-sand-deep text-brand-bark h-11 font-medium shadow-sm hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
              >
                <Lock className="w-4 h-4" /> Завершить поездку
              </button>
            </div>
          </div>
        ) : (
          /* Scan button */
          <button
            type="button"
            onClick={() => goRent(false)}
            aria-label={isRegistered ? "Сканировать QR" : "Сканировать QR (нужна регистрация)"}
            data-testid="home-primary-scan"
            className="w-full h-14 rounded-full bg-primary hover:opacity-90 text-black font-medium text-lg flex items-center justify-between px-6 shadow-lg active:scale-[0.98] transition-all"
          >
            <span>Сканировать</span>
            <QrCode className="w-6 h-6" />
          </button>
        )}
      </div>

      {/* Drawer menu */}
      <DrawerMenu open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <RegistrationModal
        open={regOpen}
        onOpenChange={(open) => {
          setRegOpen(open);
          if (!open) pendingMulti.current = null;
        }}
        onRegistered={() => {
          if (pendingMulti.current !== null) {
            const multi = pendingMulti.current;
            pendingMulti.current = null;
            openScan(multi);
          }
        }}
      />

      <QrScanModal
        open={scanOpen}
        onOpenChange={setScanOpen}
        bikes={bikesQ.data ?? []}
        onBikeSelected={onBikeScanned}
      />

      <RentalStartModal
        open={rentalOpen}
        onOpenChange={setRentalOpen}
        bike={bike ?? availableBikes[0] ?? null}
        multi={rentalMulti}
      />
    </div>
  );
}

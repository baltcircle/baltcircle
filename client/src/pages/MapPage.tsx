import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation } from "wouter";

import type { Bike, MapObject, Parking, PublicPaymentMethod, Ride } from "@shared/schema";
import type { Tariff } from "@shared/geo";
import { PAYMENT_METHODS_KEY } from "@/lib/payment";
import { MapLibreMap } from "@/components/MapLibreMap";
import { RentalStartModal } from "@/components/RentalStartModal";
import { RegistrationModal } from "@/components/RegistrationModal";
import { QrScanModal } from "@/components/QrScanModal";
import { DrawerMenu } from "@/components/DrawerMenu";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useActiveRideStream } from "@/hooks/use-active-ride-stream";
import { useFleetStream } from "@/hooks/use-fleet-stream";
import { useActiveRideTracker } from "@/hooks/use-active-ride-tracker";
import { useRideTrackPoll } from "@/hooks/use-ride-track-poll";
import { useRideGuard } from "@/hooks/use-ride-guard";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Menu, MapPin } from "lucide-react";
import { useDrawerState } from "./map/use-drawer-state";
import { useGeolocation } from "./map/use-geolocation";
import { usePaymentBanner } from "./map/use-payment-banner";
import { useReservationBanner } from "./map/use-reservation-banner";
import { usePendingBikeScan } from "./map/use-pending-bike-scan";
import { ActiveRideCard } from "./map/ActiveRideCard";
import { ScanAndPaymentBanner } from "./map/ScanAndPaymentBanner";
import { ReservationBanner } from "./map/ReservationBanner";

export function MapPage() {
  const toast = useToast();
  const [, navigate] = useLocation();
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const mapObjectsQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  const activeQ = useQuery<Ride | null>({
    queryKey: ["/api/rides/active"],
  });
  // Live active-ride updates via SSE (replaces the old 4s poll).
  useActiveRideStream();
  // Живое обновление доступности велосипедов на карте (статусы).
  useFleetStream();
  const { isRegistered, isLoading: userLoading } = useCurrentUser();

  const activeRide = activeQ.data ?? null;

  // GPS-трекер активной аренды: слушает onUserLocation от MapLibreMap и шлёт
  // точки на /api/rides/{id}/point (тротлинг 3с + фильтр GPS-дребезга <5м).
  const rideTracker = useActiveRideTracker(activeRide);

  // Авторитетный трек поездки от бортового трекера велосипеда (репортит даже при
  // заблокированном телефоне). Пока трекер отдаёт точки — рисуем маршрут по ним;
  // если трекера нет/молчит, сервер вернёт source:"phone" и мы падаем обратно на
  // трек из телефона (текущее поведение, без регресса).
  const trackPoll = useRideTrackPoll(activeRide?.id);
  // Пока замок активно отдаёт свой трек — разрыв телефонного GPS (экран заблокирован,
  // вкладка в фоне) никак не влияет на записанный маршрут — не пугаем об этом тостом.
  const trackedByLock = trackPoll.data?.source === "tracker";

  // Screen Wake Lock + уведомление о разрывах трекинга на время активной аренды.
  const rideGuard = useRideGuard(!!activeRide, trackedByLock);
  const displayRide = useMemo<Ride | null>(() => {
    if (!activeRide) return null;
    const merged = trackPoll.data;
    if (merged?.source === "tracker" && merged.points.length > 1) {
      return { ...activeRide, track: JSON.stringify(merged.points) };
    }
    return activeRide;
  }, [activeRide, trackPoll.data]);

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

  const { drawerOpen, setDrawerOpen, drawerMountedOpen, drawerInstantTick } = useDrawerState();
  const { geoCenter, lastPosRef, handleGeolocate } = useGeolocation();
  const { showPaymentBanner, dismissPaymentBanner } = usePaymentBanner(isRegistered, !!activeRide);
  const { reservation, cancelling, cancelReservation, onExpire: onReservationExpire } =
    useReservationBanner(isRegistered, !!activeRide);

  const pendingMulti = useRef<boolean | null>(null);
  // Клик по маркеру велосипеда на карте — как и goRent(), требует регистрации;
  // если её нет, откладываем открытие модалки аренды до onRegistered ниже.
  const pendingBikeId = useRef<string | null>(null);

  // Пока true — показываем «Закройте замок…» вместо тикающего таймера паузы;
  // становится false либо когда lockReport подтвердит паузу (pausedAt придёт
  // по SSE — см. эффект ниже), либо по истечении TTL армирования, либо при
  // явной отмене через «Отмена» (resume до фактической паузы).
  const [awaitingLockClose, setAwaitingLockClose] = useState(false);
  const lockCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLockCloseTimer = () => {
    if (lockCloseTimer.current) {
      clearTimeout(lockCloseTimer.current);
      lockCloseTimer.current = null;
    }
  };
  // Как только пауза реально применилась (или поездка закончилась/сменилась),
  // ожидание закрытия замка больше не актуально.
  useEffect(() => {
    if (!activeRide || activeRide.pausedAt != null) {
      clearLockCloseTimer();
      setAwaitingLockClose(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRide?.id, activeRide?.pausedAt]);
  useEffect(() => () => clearLockCloseTimer(), []);

  // Аналогично awaitingLockClose/lockCloseTimer выше, но для flow завершения —
  // отдельное состояние, чтобы ActiveRideCard могла отличать ожидание
  // паузы от ожидания завершения (разный текст/кнопка) и оба могут быть
  // активны независимо друг от друга (хотя на одном замке они взаимоисключаются
  // на сервере — requestEndRide чистит pending-паузу того же замка).
  const [awaitingEndLockClose, setAwaitingEndLockClose] = useState(false);
  const endLockCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearEndLockCloseTimer = () => {
    if (endLockCloseTimer.current) {
      clearTimeout(endLockCloseTimer.current);
      endLockCloseTimer.current = null;
    }
  };
  // Как только поездка реально завершилась (activeRide пришёл по SSE как null,
  // когда асинхронный endRide отработал на lockReport) или сменилась на другую,
  // ожидание больше не актуально.
  useEffect(() => {
    if (!activeRide) {
      clearEndLockCloseTimer();
      setAwaitingEndLockClose(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRide?.id]);
  useEffect(() => () => clearEndLockCloseTimer(), []);

  type EndResponse = Ride | { status: "awaiting_lock_close"; expiresInMs: number };

  const endMut = useMutation({
    mutationFn: async (rideId: number) => {
      const res = await apiRequest("POST", `/api/rides/${rideId}/end`);
      return res.json() as Promise<EndResponse>;
    },
    onSuccess: (data) => {
      if ("expiresInMs" in data) {
        setAwaitingEndLockClose(true);
        clearEndLockCloseTimer();
        endLockCloseTimer.current = setTimeout(() => {
          setAwaitingEndLockClose(false);
          toast.toast({
            title: "Не дождались закрытия замка",
            description: "Попробуйте завершить поездку ещё раз.",
            variant: "destructive",
          });
        }, data.expiresInMs);
        queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
        return;
      }
      clearEndLockCloseTimer();
      setAwaitingEndLockClose(false);
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

  const cancelEndMut = useMutation({
    mutationFn: async (rideId: number) => {
      const res = await apiRequest("POST", `/api/rides/${rideId}/cancel-end`);
      return res.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      clearEndLockCloseTimer();
      setAwaitingEndLockClose(false);
    },
    onError: (err: any) => {
      toast.toast({
        title: "Не удалось отменить",
        description: err?.message ?? "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
  });

  type PauseResponse =
    | { status: "paused"; ride: Ride }
    | { status: "awaiting_lock_close"; expiresInMs: number };

  const pauseMut = useMutation({
    mutationFn: async (rideId: number) => {
      const res = await apiRequest("POST", `/api/rides/${rideId}/pause`);
      return res.json() as Promise<PauseResponse>;
    },
    onSuccess: (data) => {
      if (data.status === "paused") {
        clearLockCloseTimer();
        setAwaitingLockClose(false);
        queryClient.setQueryData(["/api/rides/active"], data.ride);
      } else {
        setAwaitingLockClose(true);
        clearLockCloseTimer();
        lockCloseTimer.current = setTimeout(() => {
          setAwaitingLockClose(false);
          toast.toast({
            title: "Не дождались закрытия замка",
            description: "Попробуйте поставить на паузу ещё раз.",
            variant: "destructive",
          });
        }, data.expiresInMs);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
    },
    onError: (err: any) => {
      toast.toast({
        title: "Не удалось поставить на паузу",
        description: err?.message ?? "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
  });

  const resumeMut = useMutation({
    mutationFn: async (rideId: number) => {
      const res = await apiRequest("POST", `/api/rides/${rideId}/resume`);
      return res.json() as Promise<Ride>;
    },
    onSuccess: (ride) => {
      clearLockCloseTimer();
      setAwaitingLockClose(false);
      queryClient.setQueryData(["/api/rides/active"], ride);
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
    },
    onError: (err: any) => {
      toast.toast({
        title: "Не удалось продолжить",
        description: err?.message ?? "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
  });

  // Saved T-Bank card/SBP methods usable for a one-tap extend charge — same
  // active+RebillId/AccountToken filter as RentalStartModal's ride-start flow.
  // Only fetched once there's an active ride, since that's the only time
  // extending is possible.
  const paymentMethodsQ = useQuery<PublicPaymentMethod[]>({
    queryKey: PAYMENT_METHODS_KEY,
    enabled: !!activeRide,
  });
  const extendActiveMethods = (paymentMethodsQ.data ?? []).filter(
    (m) => m.status === "active" && m.provider === "tbank"
      && ((m.type === "card" && m.hasRebillId) || (m.type === "sbp" && m.hasAccountToken)),
  );

  // Extending a ride charges the rider's SAVED card/SBP method when one
  // exists — the wallet-balance route (`/api/rides/:id/extend`) previously
  // failed with "Недостаточно средств на балансе" for riders who never top
  // up their wallet and rely purely on a saved card. Riders with no saved
  // method keep working exactly as before via the wallet route — this is a
  // pure fallback, not a behavior change for them.
  const extendMut = useMutation({
    mutationFn: async ({ rideId, tariff }: { rideId: number; tariff: Tariff["id"] }) => {
      const method = extendActiveMethods[0];
      if (!method) {
        const res = await apiRequest("POST", `/api/rides/${rideId}/extend`, { tariff });
        return { kind: "wallet" as const, ride: (await res.json()) as Ride };
      }
      const res = await apiRequest(
        "POST",
        "/api/payments/tbank/ride/extend-saved-card",
        { tariffId: tariff, paymentMethodId: method.id },
        { "Idempotency-Key": crypto.randomUUID() },
      );
      const data = (await res.json()) as { orderId: string; status: "paid" | "pending"; rideId?: number; amountKopecks: number };
      return { kind: "card" as const, data };
    },
    onSuccess: (result) => {
      if (result.kind === "wallet") {
        queryClient.setQueryData(["/api/rides/active"], result.ride);
        queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
        queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        toast.toast({ title: "Аренда продлена" });
        return;
      }
      if (result.data.status === "paid") {
        queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        toast.toast({ title: "Аренда продлена" });
        return;
      }
      // Deferred (e.g. 3DS step-up) — let the result page poll the order until
      // the webhook resolves it, same pattern as the ride-start card charge.
      navigate(`/payment-result?orderId=${encodeURIComponent(result.data.orderId)}`);
    },
    onError: (err: any) => {
      toast.toast({
        title: "Не удалось продлить",
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

  const onMapBikeClick = (bikeId: string) => {
    if (!isRegistered) {
      pendingBikeId.current = bikeId;
      setRegOpen(true);
      return;
    }
    setSelected(bikeId);
    setRentalOpen(true);
  };

  usePendingBikeScan({
    userLoading,
    isRegistered,
    bikes: bikesQ.data,
    pendingMulti,
    setRegOpen,
    onBikeScanned,
  });

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
          bikes={bikesQ.data ?? []}
          selectedBikeId={selected}
          onSelectBike={onMapBikeClick}
          ride={displayRide}
          height="100%"
          showLabels={false}
          center={geoCenter}
          followUser={!!activeRide}
          onUserLocation={(lat, lng) => {
            lastPosRef.current = { lat, lng };
            if (activeRide) {
              rideTracker.push(lat, lng);
              rideGuard.notePoint();
            }
          }}
          className="w-full h-full"
        />
      </div>

      {/* Top bar — только кнопка меню справа */}
      <div
        className="absolute left-0 right-0 z-20 flex items-center justify-end px-4"
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
      >
        {/* Логотип и название убраны с главного экрана — остаётся только кнопка меню. */}
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

      {/* Bottom action area — floats over the map.
       * Геолокация + скан + баннер в одной вертикальной группе, анкорится по
       * нижнему краю (safe-area). Геокнопка над сканом — двигается вместе с ним. */}
      <div
        className="fixed left-4 right-4 z-40 flex flex-col items-stretch gap-4"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 0.25rem)" }}
      >
        {/* Geolocation button — над сканом, справа. */}
        <button
          type="button"
          onClick={handleGeolocate}
          aria-label="Моё местоположение"
          data-testid="home-geolocate-button"
          className="self-end w-12 h-12 rounded-full bg-primary text-black shadow-lg flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
        >
          <MapPin className="w-5 h-5" />
        </button>

        {activeRide ? (
          <ActiveRideCard
            ride={activeRide}
            onEnd={() => endMut.mutate(activeRide.id)}
            ending={endMut.isPending}
            onPause={() => pauseMut.mutate(activeRide.id)}
            onResume={() => resumeMut.mutate(activeRide.id)}
            pausing={pauseMut.isPending}
            resuming={resumeMut.isPending}
            awaitingLockClose={awaitingLockClose}
            awaitingEndLockClose={awaitingEndLockClose}
            onCancelEnd={() => cancelEndMut.mutate(activeRide.id)}
            cancellingEnd={cancelEndMut.isPending}
            onExtend={(tariff) => extendMut.mutate({ rideId: activeRide.id, tariff })}
            extending={extendMut.isPending}
          />
        ) : (
          <>
            {reservation && (
              <ReservationBanner
                reservation={reservation}
                onCancel={() => cancelReservation(reservation.id)}
                cancelling={cancelling}
                onExpire={onReservationExpire}
              />
            )}
            <ScanAndPaymentBanner
              isRegistered={isRegistered}
              onScan={() => goRent(false)}
              showPaymentBanner={showPaymentBanner}
              onDismissBanner={dismissPaymentBanner}
            />
          </>
        )}
      </div>

      {/* Drawer menu */}
      <DrawerMenu open={drawerOpen} onClose={() => setDrawerOpen(false)} mountedOpen={drawerMountedOpen.current} instantTick={drawerInstantTick} />

      <RegistrationModal
        open={regOpen}
        onOpenChange={(open) => {
          setRegOpen(open);
          if (!open) {
            pendingMulti.current = null;
            pendingBikeId.current = null;
          }
        }}
        onRegistered={() => {
          if (pendingMulti.current !== null) {
            const multi = pendingMulti.current;
            pendingMulti.current = null;
            openScan(multi);
          } else if (pendingBikeId.current) {
            const bikeId = pendingBikeId.current;
            pendingBikeId.current = null;
            setSelected(bikeId);
            setRentalOpen(true);
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

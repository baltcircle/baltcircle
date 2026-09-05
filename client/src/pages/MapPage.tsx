import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation } from "wouter";

import type { Bike, MapObject, Parking, PublicPaymentMethod, Ride } from "@shared/schema";
import type { Tariff } from "@shared/geo";
import { MAX_ACTIVE_RIDES_PER_USER } from "@shared/geo";
import { PAYMENT_METHODS_KEY } from "@/lib/payment";
import { MapLibreMap } from "@/components/MapLibreMap";
import { RentalStartModal } from "@/components/RentalStartModal";
import { AuthModal } from "@/components/AuthModal";
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
import { RideFeedbackDialog } from "@/components/RideFeedbackDialog";
import { ScanAndPaymentBanner } from "./map/ScanAndPaymentBanner";
import { ReservationBanner } from "./map/ReservationBanner";

const ACTIVE_RIDES_KEY = ["/api/rides/active"] as const;

function patchActiveRide(old: Ride[] | undefined, updated: Ride): Ride[] {
  return (old ?? []).map((r) => (r.id === updated.id ? updated : r));
}

export function MapPage() {
  const toast = useToast();
  const [, navigate] = useLocation();
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const mapObjectsQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  const activeQ = useQuery<Ride[]>({
    queryKey: ACTIVE_RIDES_KEY,
  });
  // Live active-ride updates via SSE (replaces the old 4s poll).
  useActiveRideStream();
  // Живое обновление доступности велосипедов на карте (статусы).
  useFleetStream();
  const { isRegistered, isLoading: userLoading } = useCurrentUser();

  const activeRides = activeQ.data ?? [];
  // Фиксированные "слоты" по позиции в массиве (не по фокусу) — трекер/поллер
  // не должны перемонтироваться, когда рядер просто переключает фокус между
  // двумя уже идущими поездками; каждый хук сам сбрасывает историю по ride.id.
  const rideSlotA = activeRides[0] ?? null;
  const rideSlotB = activeRides[1] ?? null;

  // Какая из (максимум двух) активных поездок сейчас показана в карточке
  // ActiveRideCard — переключается кнопками 1/2 в самой карточке.
  const [focusedRideId, setFocusedRideId] = useState<number | null>(null);
  useEffect(() => {
    if (activeRides.length === 0) {
      if (focusedRideId !== null) setFocusedRideId(null);
      return;
    }
    if (!activeRides.some((r) => r.id === focusedRideId)) {
      setFocusedRideId(activeRides[0].id);
    }
  }, [activeRides, focusedRideId]);
  const focusedRide = activeRides.find((r) => r.id === focusedRideId) ?? activeRides[0] ?? null;
  // 1/2-переключатель в самой карточке заменил отдельную SecondaryRideBar:
  // слот — стабильный номер (1 или 2) из БД, не зависит от порядка activeRides.
  const showRideSwitcher = activeRides.length >= 2;
  const onSelectSlot = (slot: 1 | 2) => {
    const target = activeRides.find((r) => r.activeSlot === slot);
    if (target) setFocusedRideId(target.id);
  };
  // Bike id shown on each switcher button in the card header, keyed by the
  // ride's stable slot (not array position) — lets the switcher read the
  // actual bike code instead of a bare "1"/"2".
  const slotBikeIds = useMemo(() => {
    const ids: Partial<Record<1 | 2, string>> = {};
    for (const r of activeRides) {
      if (r.activeSlot === 1 || r.activeSlot === 2) ids[r.activeSlot] = r.bikeId;
    }
    return ids;
  }, [activeRides]);

  // GPS-трекер активной аренды: слушает onUserLocation от MapLibreMap и шлёт
  // точки на /api/rides/{id}/point (тротлинг 3с + фильтр GPS-дребезга <5м).
  // Всегда ровно два вызова хука (см. rules-of-hooks) — по одному на слот.
  const rideTrackerA = useActiveRideTracker(rideSlotA);
  const rideTrackerB = useActiveRideTracker(rideSlotB);
  const focusedTracker = focusedRide?.id === rideSlotB?.id ? rideTrackerB : rideTrackerA;

  // Авторитетный трек поездки от бортового трекера велосипеда (репортит даже при
  // заблокированном телефоне). Пока трекер отдаёт точки — рисуем маршрут по ним;
  // если трекера нет/молчит, сервер вернёт source:"phone" и мы падаем обратно на
  // трек из телефона (текущее поведение, без регресса). Опрашиваем оба слота —
  // на карте рисуем маршрут только сфокусированной поездки.
  const trackPollA = useRideTrackPoll(rideSlotA?.id);
  const trackPollB = useRideTrackPoll(rideSlotB?.id);
  const focusedTrackPoll = focusedRide?.id === rideSlotB?.id ? trackPollB : trackPollA;
  // Пока замок активно отдаёт свой трек — разрыв телефонного GPS (экран заблокирован,
  // вкладка в фоне) никак не влияет на записанный маршрут — не пугаем об этом тостом.
  const trackedByLock = focusedTrackPoll.data?.source === "tracker";

  // Screen Wake Lock + уведомление о разрывах трекинга на время активной аренды.
  const rideGuard = useRideGuard(activeRides.length > 0, trackedByLock);
  const displayRide = useMemo<Ride | null>(() => {
    if (!focusedRide) return null;
    const merged = focusedTrackPoll.data;
    if (merged?.source === "tracker" && merged.points.length > 1) {
      return { ...focusedRide, track: JSON.stringify(merged.points) };
    }
    return focusedRide;
  }, [focusedRide, focusedTrackPoll.data]);

  // Пока своя аренда на паузе — её маркер должен красится как «Бронь», а не
  // как обычная «В аренде» (bike-status lifecycle: пауза — состояние Ride,
  // не bikes.status, поэтому цвет переопределяется отдельно от статуса).
  // Учитываем ОБЕ активные поездки, не только сфокусированную.
  const pausedBikeIds = useMemo<Set<string> | undefined>(() => {
    const ids = activeRides.filter((r) => r.pausedAt != null).map((r) => r.bikeId);
    return ids.length ? new Set(ids) : undefined;
  }, [activeRides]);

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
  const [regOpen, setRegOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [feedbackRideId, setFeedbackRideId] = useState<number | null>(null);

  const { drawerOpen, setDrawerOpen, drawerMountedOpen, drawerInstantTick } = useDrawerState();
  const { geoCenter, lastPosRef, handleGeolocate } = useGeolocation();
  const { showPaymentBanner, dismissPaymentBanner } = usePaymentBanner(isRegistered, activeRides.length > 0);
  const { reservation, cancelling, cancelReservation, onExpire: onReservationExpire } =
    useReservationBanner(isRegistered, activeRides.length > 0);

  // Rider-facing map must never surface a bike a customer couldn't rent right
  // now. The server (filterBikesForRider) already restricts /api/bikes to
  // available bikes + this rider's own rented/reserved bike (everyone else's
  // is invisible). Our own RENTED and RESERVED bikes stay visible — the rider
  // still needs to see where they are — but are rendered non-interactive via
  // nonInteractiveBikeIds below, so tapping one can't re-open the rental flow
  // on a bike that's already theirs.
  const myActiveBikeIds = useMemo(
    () => new Set(activeRides.map((r) => r.bikeId)),
    [activeRides]
  );
  const mapBikes = useMemo(
    () => bikesQ.data?.filter(
      (b) => b.status === "available"
        || (b.status === "reserved" && b.id === reservation?.bikeId)
        || (b.status === "rented" && myActiveBikeIds.has(b.id))
    ) ?? [],
    [bikesQ.data, reservation?.bikeId, myActiveBikeIds]
  );
  const nonInteractiveBikeIds = useMemo(() => {
    const ids = new Set<string>(myActiveBikeIds);
    if (reservation) ids.add(reservation.bikeId);
    return ids;
  }, [myActiveBikeIds, reservation]);

  // true пока ждём регистрацию, чтобы после неё открыть QR-скан (goRent) —
  // раньше сюда же кодировался флаг "multi", но выделенного multi-режима
  // сканирования больше нет: вторая поездка стартует тем же сканом, что и
  // первая, backend сам решает через MAX_ACTIVE_RIDES_PER_USER.
  const pendingScan = useRef<boolean>(false);
  // Клик по маркеру велосипеда на карте — как и goRent(), требует регистрации;
  // если её нет, откладываем открытие модалки аренды до onRegistered ниже.
  const pendingBikeId = useRef<string | null>(null);

  // Пока true — показываем «Закройте замок…» вместо тикающего таймера паузы;
  // становится false либо когда lockReport подтвердит паузу (pausedAt придёт
  // по SSE — см. эффект ниже), либо по истечении TTL армирования, либо при
  // явной отмене через «Отмена» (resume до фактической паузы). Храним id
  // конкретной поездки (не булево) — при двух одновременных поездках это не
  // даёт статусу паузы одной поездки "утечь" на карточку другой при
  // переключении фокуса.
  const [awaitingLockCloseRideId, setAwaitingLockCloseRideId] = useState<number | null>(null);
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
    if (awaitingLockCloseRideId == null) return;
    const ride = activeRides.find((r) => r.id === awaitingLockCloseRideId);
    if (!ride || ride.pausedAt != null) {
      clearLockCloseTimer();
      setAwaitingLockCloseRideId(null);
    }
  }, [activeRides, awaitingLockCloseRideId]);
  useEffect(() => () => clearLockCloseTimer(), []);

  // Аналогично awaitingLockClose/lockCloseTimer выше, но для flow завершения —
  // отдельное состояние, чтобы ActiveRideCard могла отличать ожидание
  // паузы от ожидания завершения (разный текст/кнопка) и оба могут быть
  // активны независимо друг от друга (хотя на одном замке они взаимоисключаются
  // на сервере — requestEndRide чистит pending-паузу того же замка).
  const [awaitingEndLockCloseRideId, setAwaitingEndLockCloseRideId] = useState<number | null>(null);
  // См. комментарий у endMut.onMutate выше — rideId завершаемой поездки,
  // нужен эффекту ниже, чтобы открыть диалог оценки после асинхронного завершения.
  const pendingEndRideId = useRef<number | null>(null);
  const endLockCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearEndLockCloseTimer = () => {
    if (endLockCloseTimer.current) {
      clearTimeout(endLockCloseTimer.current);
      endLockCloseTimer.current = null;
    }
  };
  // Как только поездка реально завершилась (пропала из списка активных, когда
  // асинхронный endRide отработал на lockReport) — открываем диалог оценки.
  // Проверяем именно по id через ref, а не "activeRides пуст": при двух
  // одновременных поездках завершение одной не обязано опустошать список.
  useEffect(() => {
    const pendingId = pendingEndRideId.current;
    if (pendingId == null) return;
    if (!activeRides.some((r) => r.id === pendingId)) {
      // Поездка реально засеттлилась пока мы ждали закрытие замка — без этой ветки
      // диалог оценки никогда не открывался для асинхронного endRide (endMut's
      // "expiresInMs" ветка возвращается до settlement и никогда не вызывает
      // setFeedbackRideId сама по себе) — это был баг из-за которого рейтинг
      // перестал появляться: большинство велосипедов с реальным замком 100% идёт через
      // эту ветку. Проверяем именно ref, а не awaitingEndLockCloseRideId — тот к этому
      // моменту мог уже сброситься по TTL-таймауту (см. endMut), а ride всё равно
      // settled чуть позже по SSE/refetch; ref остаётся источником правды до тех
      // пор, пока сам не будет использован или явно очищен новым endMut.mutate.
      setFeedbackRideId(pendingId);
      pendingEndRideId.current = null;
      clearEndLockCloseTimer();
      setAwaitingEndLockCloseRideId((cur) => (cur === pendingId ? null : cur));
    }
  }, [activeRides]);
  useEffect(() => () => clearEndLockCloseTimer(), []);

  type EndResponse = Ride | { status: "awaiting_lock_close"; expiresInMs: number };

  const endMut = useMutation({
    mutationFn: async (rideId: number) => {
      const res = await apiRequest("POST", `/api/rides/${rideId}/end`);
      return res.json() as Promise<EndResponse>;
    },
    // Запоминаем, какую поездку завершаем, ДО ответа сервера — когда замок
    // подтверждает закрытие асинхронно (awaiting_lock_close ветка ниже), эта
    // поездка к тому моменту уже пропадёт из списка активных по SSE, и data.id
    // в этом случае недоступен — без этого ref диалог оценки не знает, для
    // какой поездки его открыть.
    onMutate: (rideId) => {
      pendingEndRideId.current = rideId;
    },
    onSuccess: (data, rideId) => {
      if ("expiresInMs" in data) {
        setAwaitingEndLockCloseRideId(rideId);
        clearEndLockCloseTimer();
        endLockCloseTimer.current = setTimeout(() => {
          setAwaitingEndLockCloseRideId((cur) => (cur === rideId ? null : cur));
          toast.toast({
            title: "Не дождались закрытия замка",
            description: "Попробуйте завершить поездку ещё раз.",
            variant: "destructive",
          });
          // Защитная сетка: если push через SSE был пропущен (сеть/фон на
          // мобильном), TTL — единственный шанс заметить рассинхронизацию.
          // Обычный invalidateQueries тут не годится: без активного
          // наблюдателя он просто помечает кэш устаревшим, не выполняя
          // запрос — принудительный refetch подтягивает реальное
          // состояние (поездка могла уже завершиться на сервере).
          void queryClient.refetchQueries({ queryKey: ACTIVE_RIDES_KEY, type: "active" });
        }, data.expiresInMs);
        queryClient.invalidateQueries({ queryKey: ACTIVE_RIDES_KEY });
        return;
      }
      clearEndLockCloseTimer();
      setAwaitingEndLockCloseRideId((cur) => (cur === rideId ? null : cur));
      queryClient.invalidateQueries({ queryKey: ACTIVE_RIDES_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/rides"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      toast.toast({ title: "Поездка завершена", description: "Спасибо, что выбрали TakeRide!" });
      pendingEndRideId.current = null;
      setFeedbackRideId(data.id);
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
    onSuccess: (_data, rideId) => {
      clearEndLockCloseTimer();
      setAwaitingEndLockCloseRideId((cur) => (cur === rideId ? null : cur));
      if (pendingEndRideId.current === rideId) pendingEndRideId.current = null;
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
    onSuccess: (data, rideId) => {
      if (data.status === "paused") {
        clearLockCloseTimer();
        setAwaitingLockCloseRideId(null);
        queryClient.setQueryData<Ride[]>(ACTIVE_RIDES_KEY, (old) => patchActiveRide(old, data.ride));
      } else {
        setAwaitingLockCloseRideId(rideId);
        clearLockCloseTimer();
        lockCloseTimer.current = setTimeout(() => {
          setAwaitingLockCloseRideId((cur) => (cur === rideId ? null : cur));
          toast.toast({
            title: "Не дождались закрытия замка",
            description: "Попробуйте поставить на паузу ещё раз.",
            variant: "destructive",
          });
          // См. аналогичный комментарий в endMut — форсируем ресинк на случай
          // пропущенного SSE-пуша.
          void queryClient.refetchQueries({ queryKey: ACTIVE_RIDES_KEY, type: "active" });
        }, data.expiresInMs);
      }
      queryClient.invalidateQueries({ queryKey: ACTIVE_RIDES_KEY });
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
      setAwaitingLockCloseRideId(null);
      queryClient.setQueryData<Ride[]>(ACTIVE_RIDES_KEY, (old) => patchActiveRide(old, ride));
      queryClient.invalidateQueries({ queryKey: ACTIVE_RIDES_KEY });
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
    enabled: activeRides.length > 0,
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
        { rideId, tariffId: tariff, paymentMethodId: method.id },
        { "Idempotency-Key": crypto.randomUUID() },
      );
      const data = (await res.json()) as { orderId: string; status: "paid" | "pending"; rideId?: number; amountKopecks: number };
      return { kind: "card" as const, data };
    },
    onSuccess: (result) => {
      if (result.kind === "wallet") {
        queryClient.setQueryData<Ride[]>(ACTIVE_RIDES_KEY, (old) => patchActiveRide(old, result.ride));
        queryClient.invalidateQueries({ queryKey: ACTIVE_RIDES_KEY });
        queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
        queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
        toast.toast({ title: "Аренда продлена" });
        return;
      }
      if (result.data.status === "paid") {
        queryClient.invalidateQueries({ queryKey: ACTIVE_RIDES_KEY });
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

  const goRent = () => {
    if (!isRegistered) {
      pendingScan.current = true;
      setRegOpen(true);
      return;
    }
    setScanOpen(true);
  };

  const onBikeScanned = (b: Bike) => {
    setSelected(b.id);
    setRentalOpen(true);
  };

  const onMapBikeClick = (bikeId: string) => {
    // Defensive re-check even though the map no longer renders a clickable
    // marker for our own reserved bike (nonInteractiveBikeId) or for our own
    // rented bike (excluded from mapBikes entirely) — guards against a stale
    // marker click racing a status change that hasn't re-rendered yet.
    const clicked = bikesQ.data?.find((b) => b.id === bikeId);
    if (!clicked || clicked.status !== "available") return;
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
    pendingScan,
    setRegOpen,
    onBikeScanned,
  });

  const canAddSecondRide = activeRides.length > 0 && activeRides.length < MAX_ACTIVE_RIDES_PER_USER;

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
          bikes={mapBikes}
          pausedBikeIds={pausedBikeIds}
          nonInteractiveBikeIds={nonInteractiveBikeIds}
          selectedBikeId={selected}
          onSelectBike={onMapBikeClick}
          ride={displayRide}
          height="100%"
          showLabels={false}
          center={geoCenter}
          followUser={activeRides.length > 0}
          onUserLocation={(lat, lng) => {
            lastPosRef.current = { lat, lng };
            // Телефон физически может быть только у одного велосипеда — шлём
            // GPS только на трекер СФОКУСИРОВАННОЙ поездки; у второй поездки
            // расстояние считается по её собственному бортовому трекеру
            // (see use-ride-track-poll), фолбэк на "чужой" телефонный GPS
            // испортил бы её маршрут.
            if (focusedRide) {
              focusedTracker.push(lat, lng);
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

        {focusedRide ? (
          <ActiveRideCard
            ride={focusedRide}
            onEnd={() => endMut.mutate(focusedRide.id)}
            ending={endMut.isPending}
            onPause={() => pauseMut.mutate(focusedRide.id)}
            onResume={() => resumeMut.mutate(focusedRide.id)}
            pausing={pauseMut.isPending}
            resuming={resumeMut.isPending}
            awaitingLockClose={awaitingLockCloseRideId === focusedRide.id}
            awaitingEndLockClose={awaitingEndLockCloseRideId === focusedRide.id}
            onCancelEnd={() => cancelEndMut.mutate(focusedRide.id)}
            cancellingEnd={cancelEndMut.isPending}
            onExtend={(tariff) => extendMut.mutate({ rideId: focusedRide.id, tariff })}
            extending={extendMut.isPending}
            showAddSecondRide={canAddSecondRide}
            onAddSecondRide={() => setScanOpen(true)}
            showRideSwitcher={showRideSwitcher}
            activeSlot={(focusedRide.activeSlot as 1 | 2) ?? 1}
            onSelectSlot={onSelectSlot}
            slotBikeIds={slotBikeIds}
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
              onScan={goRent}
              showPaymentBanner={showPaymentBanner}
              onDismissBanner={dismissPaymentBanner}
            />
          </>
        )}
      </div>

      {/* Drawer menu */}
      <DrawerMenu open={drawerOpen} onClose={() => setDrawerOpen(false)} mountedOpen={drawerMountedOpen.current} instantTick={drawerInstantTick} />

      <AuthModal
        open={regOpen}
        onOpenChange={(open) => {
          setRegOpen(open);
          if (!open) {
            pendingScan.current = false;
            pendingBikeId.current = null;
          }
        }}
        onRegistered={() => {
          if (pendingScan.current) {
            pendingScan.current = false;
            setScanOpen(true);
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
        myActiveRideBikeIds={activeRides.map((r) => r.bikeId)}
        myReservationBikeId={reservation?.bikeId ?? null}
        onBikeSelected={onBikeScanned}
      />

      <RentalStartModal
        open={rentalOpen}
        onOpenChange={setRentalOpen}
        bike={bike ?? availableBikes[0] ?? null}
      />

      <RideFeedbackDialog
        open={feedbackRideId !== null}
        onOpenChange={(v) => !v && setFeedbackRideId(null)}
        rideId={feedbackRideId}
      />
    </div>
  );
}

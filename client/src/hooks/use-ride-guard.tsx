import { useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { TRACK_GAP_MS } from "@/lib/geoSmoothing";

/**
 * Страж активной аренды. Пока идёт поездка:
 *
 *  1) Держит Screen Wake Lock — экран не гаснет от бездействия, что уменьшает
 *     частоту разрывов трека из-за автоблокировки. НЕ спасает, если пользователь
 *     сам жмёт кнопку блокировки или сворачивает приложение — это ограничение
 *     платформы, из браузера не обойти. API есть не везде (старый Safari) —
 *     работаем с graceful fallback.
 *  2) Ловит разрывы трекинга и ненавязчиво сообщает о них тостом, чтобы обрыв
 *     линии на карте не выглядел багом. Два независимых сигнала:
 *       — visibilitychange / pagehide / pageshow: вкладка ушла в фон и вернулась
 *         (браузер приостанавливает watchPosition в фоне);
 *       — временной разрыв между принятыми GPS-точками > TRACK_GAP_MS (потеря
 *         сигнала без ухода в фон).
 *
 * Рендер трека рвёт линию сам по timestamp'ам точек (см. segmentTrack) — этот
 * хук отвечает только за wake lock и уведомление пользователя.
 */
export function useRideGuard(active: boolean) {
  const { toast } = useToast();
  // WakeLockSentinel типизирован не во всех окружениях — держим как any.
  const wakeLockRef = useRef<any>(null);
  const hiddenAtRef = useRef<number | null>(null);
  const lastPointAtRef = useRef<number | null>(null);
  const announcedRef = useRef(false);

  const announceGap = (ms: number) => {
    if (announcedRef.current) return; // не дублируем на «двойном» сигнале
    announcedRef.current = true;
    // Сбрасываем флаг чуть позже — следующий реальный разрыв снова сообщим.
    setTimeout(() => { announcedRef.current = false; }, 5_000);
    const secs = Math.max(1, Math.round(ms / 1000));
    toast({
      title: "Трекинг был приостановлен",
      description: `~${secs} сек не записано — часть маршрута пропущена.`,
    });
  };

  useEffect(() => {
    if (!active) return;

    const nav = navigator as any;
    const supportsWakeLock = typeof navigator !== "undefined" && "wakeLock" in navigator && !!nav.wakeLock;

    const requestWakeLock = async () => {
      if (!supportsWakeLock || wakeLockRef.current) return;
      try {
        const sentinel = await nav.wakeLock.request("screen");
        wakeLockRef.current = sentinel;
        // Система освобождает lock сама при уходе в фон — забываем ссылку,
        // чтобы при возврате видимости запросить заново.
        sentinel.addEventListener?.("release", () => { wakeLockRef.current = null; });
      } catch {
        /* не поддержано / отклонено — молча продолжаем без lock */
      }
    };

    const releaseWakeLock = () => {
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      sentinel?.release?.().catch(() => {});
    };

    const markHidden = () => {
      if (hiddenAtRef.current == null) hiddenAtRef.current = Date.now();
    };

    const markVisible = () => {
      // Lock мог быть освобождён системой в фоне — берём заново.
      void requestWakeLock();
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt != null) {
        const away = Date.now() - hiddenAt;
        // Обнуляем «последнюю точку» — иначе первая точка после возврата
        // выстрелит вторым тостом через notePoint по тому же разрыву.
        lastPointAtRef.current = Date.now();
        if (away > TRACK_GAP_MS) announceGap(away);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") markHidden();
      else markVisible();
    };

    void requestWakeLock();
    document.addEventListener("visibilitychange", onVisibility);
    // iOS Safari не всегда шлёт visibilitychange при блокировке — pagehide/pageshow
    // как страховка.
    window.addEventListener("pagehide", markHidden);
    window.addEventListener("pageshow", markVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", markHidden);
      window.removeEventListener("pageshow", markVisible);
      hiddenAtRef.current = null;
      lastPointAtRef.current = null;
      releaseWakeLock();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** Сообщить о принятой GPS-точке — ловит разрыв по времени без ухода в фон. */
  const notePoint = () => {
    const now = Date.now();
    const last = lastPointAtRef.current;
    lastPointAtRef.current = now;
    if (
      last != null &&
      now - last > TRACK_GAP_MS &&
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    ) {
      announceGap(now - last);
    }
  };

  return { notePoint };
}

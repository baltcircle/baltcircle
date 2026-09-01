import { useEffect, useRef } from "react";

/**
 * Страж активной аренды. Пока идёт поездка, держит Screen Wake Lock —
 * экран не гаснет от бездействия. НЕ спасает, если пользователь сам
 * жмёт кнопку блокировки или сворачивает приложение — это ограничение
 * платформы, из браузера не обойти. API есть не везде (старый Safari) —
 * работаем с graceful fallback.
 *
 * Раньше тут же был тост о разрыве телефонного трекинга (сворачивание
 * приложения / блокировка экрана). Убран по продуктовому решению:
 * авторитетный источник трека — бортовой трекер замка, а не GPS телефона
 * (см. use-ride-track-poll → MergedTrack.source === "tracker"), поэтому уход телефона
 * в фон никак не влияет на записанный маршрут, и тост только вводил пользователя
 * в заблуждение (“трекинг приостановлен” при сворачивании приложения, хотя
 * реальный трек нигде не терялся). Удалён полностью. `trackedByLock` и
 * `notePoint()` оставлены в сигнатуре как no-op для совместимости с вызовающим кодом
 * (MapPage), чтобы не трогать лишние места.
 *
 * Рендер трека рвёт линию сам по timestamp'ам точек (см. segmentTrack) — этот
 * хук отвечает только за wake lock.
 */
export function useRideGuard(active: boolean, _trackedByLock: boolean = false) {
  // WakeLockSentinel типизирован не во всех окружениях — держим как any.
  const wakeLockRef = useRef<any>(null);

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

    const onVisibility = () => {
      // Lock мог быть освобождён системой в фоне — при возврате видимости берём заново.
      if (document.visibilityState === "visible") void requestWakeLock();
    };
    const onPageShow = () => void requestWakeLock();

    void requestWakeLock();
    document.addEventListener("visibilitychange", onVisibility);
    // iOS Safari не всегда шлёт visibilitychange при блокировке — pageshow
    // как страховка.
    window.addEventListener("pageshow", onPageShow);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      releaseWakeLock();
    };
  }, [active]);

  /** no-op: оставлено для совместимости со вызывающим кодом (MapPage). */
  const notePoint = () => {};

  return { notePoint };
}

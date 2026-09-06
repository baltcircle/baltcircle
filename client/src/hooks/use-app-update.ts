import { useCallback, useEffect, useRef, useState } from "react";

import type { Ride } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";
import { BUILD_ID, fetchServerBuildId, isOutdated } from "@/lib/app-version";

/** Периодическая фоновая проверка — редкая, чтобы не шуметь запросами. */
const POLL_INTERVAL_MS = 30 * 60 * 1000;
/**
 * Сколько приложение должно пробыть в фоне, чтобы обновиться молча.
 * Возврат в standalone-окно после долгой паузы визуально неотличим от
 * холодного старта — перезагрузка в этот момент не выглядит как сбой.
 */
const SILENT_RELOAD_HIDDEN_MS = 10 * 60 * 1000;
/** Сколько молчать после «Позже», чтобы баннер не возвращался на каждом
 * возврате во вкладку. */
const SNOOZE_MS = 2 * 60 * 60 * 1000;
/** Защита от петли: если после перезагрузки версия не сменилась. */
const RELOAD_GUARD_KEY = "bc.update.reload";
const RELOAD_GUARD_TTL_MS = 60_000;

interface ReloadGuard {
  to: string;
  at: number;
}

function readGuard(): ReloadGuard | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReloadGuard>;
    if (typeof parsed.to !== "string" || typeof parsed.at !== "number") return null;
    return { to: parsed.to, at: parsed.at };
  } catch {
    return null;
  }
}

function writeGuard(to: string): void {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ to, at: Date.now() }));
  } catch {
    /* Private Mode — просто теряем защиту от повтора, не критично. */
  }
}

function clearGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    /* ignore */
  }
}

function hasActiveRide(): boolean {
  const rides = queryClient.getQueryData<Ride[]>(["/api/rides/active"]);
  return Array.isArray(rides) && rides.length > 0;
}

interface AppUpdate {
  /** На сервере лежит другая сборка и пользователь ещё не перезагрузился. */
  updateReady: boolean;
  /** Применить обновление: обновить SW и перезагрузить документ. */
  applyUpdate: () => void;
  /** «Позже»: скрыть баннер на пару часов (обновление не отменяется). */
  dismiss: () => void;
}

/**
 * Следит за появлением новой сборки на сервере.
 *
 * Переустановка иконки пользователем НЕ требуется: SW ничего не кэширует, а
 * PWA грузит документ с того же origin. Достаточно перезагрузить страницу —
 * этот хук решает, сделать это молча или предложить кнопкой.
 */
export function useAppUpdate(): AppUpdate {
  const [updateReady, setUpdateReady] = useState(false);
  const snoozeUntilRef = useRef(0);
  const hiddenAtRef = useRef<number | null>(null);
  // Если предыдущая перезагрузка не сменила версию (сервер за CDN/прокси всё
  // ещё отдаёт старый index.html) — молча перезагружаться больше нельзя,
  // иначе приложение зациклится. Баннер при этом остаётся доступен.
  const silentAllowedRef = useRef(true);

  useEffect(() => {
    const guard = readGuard();
    if (!guard) return;
    if (guard.to === BUILD_ID) {
      clearGuard();
      return;
    }
    if (Date.now() - guard.at < RELOAD_GUARD_TTL_MS) {
      silentAllowedRef.current = false;
    }
    clearGuard();
  }, []);

  const applyUpdate = useCallback(() => {
    // Осознанное действие пользователя — guard не ставим: он защищает только
    // от петли АВТОматических перезагрузок.
    void (async () => {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
      } catch {
        /* SW опционален — перезагружаемся в любом случае. */
      }
      window.location.reload();
    })();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    let cancelled = false;
    const ctrl = new AbortController();

    const check = async () => {
      const serverId = await fetchServerBuildId(ctrl.signal);
      if (cancelled || !isOutdated(serverId)) return;
      if (Date.now() < snoozeUntilRef.current) return;

      // Обновление SW делаем всегда — даже если перезагрузку отложили,
      // push-обработчик должен быть свежим.
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
      } catch {
        /* ignore */
      }
      if (cancelled) return;

      const hiddenFor = hiddenAtRef.current ? Date.now() - hiddenAtRef.current : 0;
      const canReloadSilently =
        silentAllowedRef.current &&
        !hasActiveRide() &&
        hiddenFor >= SILENT_RELOAD_HIDDEN_MS &&
        document.visibilityState === "visible";

      if (canReloadSilently) {
        writeGuard(serverId as string);
        window.location.reload();
        return;
      }
      setUpdateReady(true);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      void check();
      hiddenAtRef.current = null;
    };

    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
    };
  }, []);

  const dismiss = useCallback(() => {
    snoozeUntilRef.current = Date.now() + SNOOZE_MS;
    setUpdateReady(false);
  }, []);

  return { updateReady, applyUpdate, dismiss };
}

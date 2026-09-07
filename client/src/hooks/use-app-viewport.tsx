import { useEffect, useRef } from "react";
import {
  nextAppHeight,
  readViewportSample,
  type AppHeightState,
} from "@/lib/viewport-metrics";

/**
 * Locks a route to the *actually visible* viewport on mobile browsers.
 *
 * Mobile browsers (Yandex, Safari, Chrome) reserve a variable-height chrome
 * bar at the bottom that CSS `100vh`/`100dvh` do not always subtract in time —
 * Yandex in particular keeps a tall search/address bar that overlaps fixed
 * content. `window.visualViewport.height` reports the real, currently-visible
 * height including that chrome, so we mirror it into `--app-height` and drive
 * the shell off that value with `svh`/`dvh` as static fallbacks.
 *
 * Restores from the background (returning from a bank app opened through an SBP
 * deeplink, from the share sheet, from the app switcher) are the fragile case:
 * WebKit reports transient undersized metrics and does not reliably fire a
 * settling `resize` afterwards. Two things guard against a shell that stays
 * short of the screen: `nextAppHeight` refuses to shrink the height while the
 * width is unchanged, and every restore event schedules delayed re-measures.
 *
 * Active only while `enabled` (the customer map route). When disabled it
 * clears the lock so other routes keep normal document scrolling.
 */
export function useAppViewport(enabled: boolean) {
  const heightRef = useRef<AppHeightState | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const root = document.documentElement;
    const vv = window.visualViewport;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const apply = () => {
      const sample = readViewportSample(window);

      const state = nextAppHeight(heightRef.current, sample);
      if (state) {
        heightRef.current = state;
        root.style.setProperty("--app-height", `${state.height}px`);
      }

      // Реально видимая высота (без URL-бара / нижней chrome-панели Safari).
      // Используется для overlay-элементов (drawer, модалки), которые должны
      // умещаться в текущий visualViewport, а не залезать под URL-бар. Здесь
      // пол не нужен: эта величина обязана уменьшаться вместе с chrome.
      const visible = Math.round(vv?.height ?? window.innerHeight);
      if (visible > 0) root.style.setProperty("--visible-height", `${visible}px`);

      // Сдвиг visualViewport относительно layout viewport сверху
      // (обычно 0, но > 0 если появляется top-URL-bar на Android).
      const offsetTop = vv?.offsetTop ?? 0;
      root.style.setProperty("--visible-top", `${Math.round(offsetTop)}px`);
    };

    // Метрики после восстановления из фона устаканиваются не сразу и без
    // гарантированного события — поэтому добираем несколькими замерами.
    const applySoon = () => {
      apply();
      requestAnimationFrame(apply);
      for (const delay of [150, 400, 900]) {
        const t = setTimeout(() => {
          timers.delete(t);
          apply();
        }, delay);
        timers.add(t);
      }
    };

    const onRestore = () => {
      if (document.visibilityState !== "visible") return;
      applySoon();
    };

    apply();

    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", applySoon);
    window.addEventListener("pageshow", onRestore);
    window.addEventListener("focus", onRestore);
    document.addEventListener("visibilitychange", onRestore);

    // Lock the page itself: no body scroll / rubber-band overscroll on this
    // route. Map gestures are unaffected — they live inside the map container.
    root.classList.add("route-locked");
    document.body.classList.add("route-locked");

    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", applySoon);
      window.removeEventListener("pageshow", onRestore);
      window.removeEventListener("focus", onRestore);
      document.removeEventListener("visibilitychange", onRestore);
      root.classList.remove("route-locked");
      document.body.classList.remove("route-locked");
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--visible-height");
      root.style.removeProperty("--visible-top");
    };
  }, [enabled]);
}

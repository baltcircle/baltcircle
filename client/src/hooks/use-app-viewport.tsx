import { useEffect } from "react";

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
 * Active only while `enabled` (the customer map route). When disabled it
 * clears the lock so other routes keep normal document scrolling.
 */
export function useAppViewport(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    const root = document.documentElement;
    const vv = window.visualViewport;

    const apply = () => {
      // Берём МАКСИМУМ из доступных высот, чтобы AppShell тянулся до низа
      // физического экрана iOS Safari, а не обрывался на URL-баре (visualViewport.height).
      // window.screen.height — физический экран, innerHeight — лайаут-вьюпорт, vv.height —
      // визуальный. Берём max — это всегда высота всего экрана, без учёта chrome браузера.
      const h = Math.max(
        window.screen?.height ?? 0,
        window.innerHeight,
        vv?.height ?? 0,
        document.documentElement.clientHeight,
      );
      root.style.setProperty("--app-height", `${Math.round(h)}px`);
    };

    apply();

    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);

    // Lock the page itself: no body scroll / rubber-band overscroll on this
    // route. Map gestures are unaffected — they live inside the map container.
    root.classList.add("route-locked");
    document.body.classList.add("route-locked");

    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      root.classList.remove("route-locked");
      document.body.classList.remove("route-locked");
      root.style.removeProperty("--app-height");
    };
  }, [enabled]);
}

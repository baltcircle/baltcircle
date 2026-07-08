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
      const innerH = vv?.height ?? window.innerHeight;
      root.style.setProperty("--app-height", `${Math.round(innerH)}px`);

      // JS-computed safe-area insets from screen.height - innerHeight.
      // iOS Safari (not PWA) returns env(safe-area-inset-bottom) = 0 even when
      // the home-indicator zone reserves ~34px of screen chrome. We compute
      // the missing bottom inset ourselves so the map can physically extend
      // past visualViewport into the home-indicator zone.
      const screenH = window.screen?.height ?? innerH;
      const missing = Math.max(0, screenH - innerH);
      // Heuristic: iPhones with home indicator have ~34px of chrome BELOW the
      // visible viewport; if there's more missing than that, the rest is the
      // top safe-area (notch/Dynamic Island).
      const bot = Math.min(missing, 34);
      const top = Math.max(0, missing - bot);
      root.style.setProperty("--map-inset-top", `${top}px`);
      root.style.setProperty("--map-inset-bottom", `${bot}px`);
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
      root.style.removeProperty("--map-inset-top");
      root.style.removeProperty("--map-inset-bottom");
    };
  }, [enabled]);
}

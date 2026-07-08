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
      const h = vv?.height ?? window.innerHeight;
      root.style.setProperty("--app-height", `${Math.round(h)}px`);

      // iOS PWA (Add-to-Home-Screen) with black-translucent status bar reports
      // env(safe-area-inset-*) = 0, but the WebView is still clipped to
      // window.innerHeight — leaving strips of html-background above the
      // status bar and below the home indicator.
      //
      // We reconstruct those insets manually from screen vs innerHeight:
      //   totalMissing = screen.height - innerHeight
      // and split it heuristically between top and bottom based on device
      // class (iPhone with home indicator: ~44px status + ~34px indicator).
      const nav = navigator as unknown as { standalone?: boolean };
      const standalone =
        nav.standalone === true ||
        window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches;
      const screenH = window.screen?.height ?? 0;
      const innerH = window.innerHeight;
      const missing = Math.max(0, screenH - innerH);
      // On iPhones with a home indicator (all Face-ID models) it's always 34px
      // in portrait, so the remaining is the status-bar height.
      // On older Touch-ID iPhones (SE/8) there is no home indicator, and the
      // whole missing region is the status-bar area at the top.
      // Detect Face-ID class via matchMedia(dynamic-range) is unreliable; we
      // use the 34px assumption whenever missing > 34.
      let insetTop = 0;
      let insetBottom = 0;
      if (standalone && missing > 0) {
        if (missing > 34) {
          insetBottom = 34;
          insetTop = missing - 34;
        } else {
          // No home indicator — all missing space is the top status bar.
          insetTop = missing;
        }
      }
      root.style.setProperty("--map-inset-top", `${insetTop}px`);
      root.style.setProperty("--map-inset-bottom", `${insetBottom}px`);
      root.style.setProperty(
        "--screen-height",
        `${Math.max(screenH, innerH)}px`,
      );
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
      root.style.removeProperty("--screen-height");
    };
  }, [enabled]);
}

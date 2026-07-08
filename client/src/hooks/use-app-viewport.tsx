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
      // Реальная физическая высота экрана — надёжнее чем 100vh + env(),
      // потому что в iOS PWA 100vh неоднозначен (819 vs 793).
      root.style.setProperty("--map-screen-height", `${screenH}px`);

      // DEBUG: fill overlay. Uses hidden probes to read real env() values.
      const overlay = document.getElementById("map-debug-overlay");
      if (overlay) {
        // Create/reuse hidden probes measuring env(safe-area-inset-*).
        let probeT = document.getElementById("env-probe-t") as HTMLElement | null;
        let probeB = document.getElementById("env-probe-b") as HTMLElement | null;
        if (!probeT) {
          probeT = document.createElement("div");
          probeT.id = "env-probe-t";
          probeT.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top);pointer-events:none;visibility:hidden;";
          document.body.appendChild(probeT);
        }
        if (!probeB) {
          probeB = document.createElement("div");
          probeB.id = "env-probe-b";
          probeB.style.cssText = "position:fixed;bottom:0;left:0;width:0;height:env(safe-area-inset-bottom);pointer-events:none;visibility:hidden;";
          document.body.appendChild(probeB);
        }
        const envT = Math.round(probeT.getBoundingClientRect().height);
        const envB = Math.round(probeB.getBoundingClientRect().height);
        const set = (k: string, v: string) => {
          const el = overlay.querySelector(`[data-k="${k}"]`);
          if (el) el.textContent = v;
        };
        set("envT", `${envT}`);
        set("envB", `${envB}`);
        set("varT", `${top}px`);
        set("varB", `${bot}px`);
        set("innerH", `${Math.round(innerH)}`);
        set("scrH", `${screenH}`);
        set("sa", String((window.navigator as any).standalone === true));

        // Реальный bounding-box карты (первый canvas MapLibre).
        const mapEl = document.querySelector(".maplibregl-map") as HTMLElement | null;
        if (mapEl) {
          const r = mapEl.getBoundingClientRect();
          set("mapH", `${Math.round(r.height)}`);
          const topEl = overlay.querySelector('[data-k="mapTop"]');
          const botEl = overlay.querySelector('[data-k="mapBot"]');
          if (topEl) topEl.textContent = `${Math.round(r.top)}`;
          if (botEl) botEl.textContent = `${Math.round(r.bottom)}`;
        }
      }
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
      root.style.removeProperty("--map-screen-height");
    };
  }, [enabled]);
}

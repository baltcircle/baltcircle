// Loads the official Yandex Maps JS API v2.1 exactly once and resolves with
// the global `ymaps` namespace after `ymaps.ready`. Returns a rejected promise
// when no API key is configured or the script fails to load, so callers can
// fall back to the stylized demo map instead of white-screening.

const API_KEY = import.meta.env.VITE_YANDEX_MAPS_API_KEY as string | undefined;

let loader: Promise<any> | null = null;

export function hasYandexKey(): boolean {
  return typeof API_KEY === "string" && API_KEY.trim().length > 0;
}

export function loadYandexMaps(): Promise<any> {
  if (loader) return loader;

  loader = new Promise((resolve, reject) => {
    if (!hasYandexKey()) {
      reject(new Error("VITE_YANDEX_MAPS_API_KEY is not set"));
      return;
    }
    if (typeof window === "undefined") {
      reject(new Error("Yandex Maps can only load in the browser"));
      return;
    }

    const w = window as any;
    const finish = () => w.ymaps.ready(() => resolve(w.ymaps));

    if (w.ymaps && typeof w.ymaps.ready === "function") {
      finish();
      return;
    }

    const src =
      "https://api-maps.yandex.ru/2.1/?apikey=" +
      encodeURIComponent(API_KEY!.trim()) +
      "&lang=ru_RU";

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-yandex-maps="1"]',
    );
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = src;
      script.async = true;
      script.dataset.yandexMaps = "1";
    }
    script.addEventListener("load", finish, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Failed to load Yandex Maps API")),
      { once: true },
    );
    if (!existing) document.head.appendChild(script);
  });

  // Allow a later retry if this attempt failed.
  loader.catch(() => {
    loader = null;
  });

  return loader;
}

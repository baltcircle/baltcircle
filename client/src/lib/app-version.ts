// Проверка «на сервере уже лежит другая сборка».
//
// Service worker приложения НИЧЕГО не кэширует (нет fetch-обработчика), поэтому
// переустанавливать иконку с экрана «Домой» при выкатке не нужно никогда:
// PWA — это ярлык на тот же origin. Проблема ровно одна: standalone-окно на iOS
// может неделями жить без перезагрузки документа, и пользователь остаётся на
// старом бандле. Отсюда — явная проверка версии и предложение перезагрузиться.

/** Версия, из которой собран ЭТОТ загруженный бандл (define в vite.config.ts). */
export const BUILD_ID: string =
  typeof __BUILD_ID__ === "string" && __BUILD_ID__ ? __BUILD_ID__ : "dev";

const VERSION_URL = "/version.json";
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Версия статики, лежащей на сервере прямо сейчас.
 * null — сеть недоступна, файл не найден (dev-режим) или ответ не распознан.
 * Молча возвращаем null: проверка обновлений не должна ломать работу приложения.
 */
export async function fetchServerBuildId(signal?: AbortSignal): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(VERSION_URL, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    // SPA-fallback отдаёт index.html на любой неизвестный путь — в dev это
    // означает HTML вместо JSON, и парсинг должен просто вернуть null.
    const data = (await res.json()) as { buildId?: unknown };
    return typeof data.buildId === "string" && data.buildId ? data.buildId : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Есть ли на сервере сборка, отличная от загруженной. */
export function isOutdated(serverBuildId: string | null): boolean {
  if (!serverBuildId) return false;
  if (BUILD_ID === "dev") return false; // dev-сервер: version.json не отдаётся
  return serverBuildId !== BUILD_ID;
}

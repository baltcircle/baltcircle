// Web Push helpers для клиента.
//
// v1: подписка/отписка через SW + backend /api/push/*.
// Поддержка iOS Safari — только когда PWA установлена (standalone).

import { apiRequest } from "./queryClient";

export type PushState =
  | "unsupported"          // браузер вообще без Push API
  | "ios-need-standalone"  // iOS Safari, но PWA не установлена на экран Домой
  | "denied"               // пользователь запретил уведомления
  | "granted-subscribed"   // подписка активна
  | "granted-unsubscribed" // permission granted, но подписки в браузере нет
  | "default";             // разрешение ещё не спрашивали

const SW_URL = "/sw.js";

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPad с iPadOS 13+ маскируется под Mac — проверяем touch.
  const iPadOsMac = ua.includes("Macintosh") && "ontouchend" in document;
  return /iPad|iPhone|iPod/.test(ua) || iPadOsMac;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mm = window.matchMedia?.("(display-mode: standalone)").matches;
  // iOS-специфичное свойство.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return !!(mm || iosStandalone);
}

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch (err) {
    console.warn("[push] SW registration failed:", err);
    return null;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function fetchVapidKey(): Promise<string> {
  const res = await apiRequest("GET", "/api/push/vapid-key");
  const data = (await res.json()) as { publicKey?: string };
  if (!data.publicKey) throw new Error("VAPID key missing");
  return data.publicKey;
}

export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) {
    if (isIos() && !isStandalone()) return "ios-need-standalone";
    return "unsupported";
  }
  if (isIos() && !isStandalone()) return "ios-need-standalone";

  const permission = Notification.permission;
  if (permission === "denied") return "denied";

  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;

  if (permission === "granted") {
    return sub ? "granted-subscribed" : "granted-unsubscribed";
  }
  return "default";
}

/**
 * Основной entry-point для кнопки в Settings.
 * Возвращает новое состояние.
 */
export async function subscribePush(): Promise<PushState> {
  if (!isPushSupported()) {
    return isIos() && !isStandalone() ? "ios-need-standalone" : "unsupported";
  }
  if (isIos() && !isStandalone()) return "ios-need-standalone";

  // 1) SW.
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) reg = (await registerServiceWorker()) ?? undefined;
  if (!reg) throw new Error("Service Worker недоступен");
  // Ждём готовности (SW может быть в состоянии installing).
  await navigator.serviceWorker.ready;

  // 2) Permission.
  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") return permission === "denied" ? "denied" : "default";

  // 3) VAPID + subscribe.
  const vapidKey = await fetchVapidKey();
  const existing = await reg.pushManager.getSubscription();
  const subscription = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });

  const json = subscription.toJSON();
  await apiRequest("POST", "/api/push/subscribe", {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
    userAgent: navigator.userAgent,
  });

  return "granted-subscribed";
}

export async function unsubscribePush(): Promise<PushState> {
  if (!isPushSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch { /* noop */ }
    try {
      await apiRequest("POST", "/api/push/unsubscribe", { endpoint });
    } catch { /* noop — endpoint уже мог быть удалён */ }
  }
  return "granted-unsubscribed";
}

export function pushStateLabel(state: PushState): string {
  switch (state) {
    case "granted-subscribed":   return "Включены";
    case "granted-unsubscribed": return "Выключены";
    case "denied":               return "Заблокированы в браузере";
    case "default":              return "Выключены";
    case "ios-need-standalone":  return "Установите приложение на экран «Домой»";
    case "unsupported":          return "Не поддерживаются браузером";
    default:                     return "";
  }
}

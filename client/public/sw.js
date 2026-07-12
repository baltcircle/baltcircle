/* TakeRide Service Worker — Web Push + basic install/activate lifecycle. */

const CACHE_VERSION = "takeride-v1";

self.addEventListener("install", () => {
  // Активируемся сразу, без ожидания закрытия старых вкладок.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "TakeRide", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "TakeRide";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icon-192.png",
    badge: "/icon-192.png",
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    data: {
      url: payload.url || "/",
      ...(payload.data || {}),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Если открыта вкладка приложения — фокус + навигация.
    for (const client of allClients) {
      try {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(targetUrl);
          }
          return;
        }
      } catch { /* noop */ }
    }
    // Иначе — открываем новую.
    await self.clients.openWindow(targetUrl);
  })());
});

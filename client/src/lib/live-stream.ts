// Browser reconnection covers explicit errors; the watchdog covers silent mobile
// TCP loss. HTTP query polling remains independent of this transport.
export function openLiveStream(url: string, handlers: Record<string, () => void>, onOpen: () => void) {
  let source: EventSource | undefined;
  let disposed = false;
  let lastActivity = Date.now();
  const connect = () => {
    if (disposed) return;
    source?.close();
    lastActivity = Date.now();
    const current = new EventSource(url, { withCredentials: true });
    source = current;
    const live = () => !disposed && source === current;
    current.onopen = () => { if (live()) { lastActivity = Date.now(); onOpen(); } };
    for (const [name, handler] of Object.entries(handlers)) {
      current.addEventListener(name, () => {
        if (!live()) return;
        lastActivity = Date.now();
        handler();
      });
    }
    current.addEventListener("heartbeat", () => { if (live()) lastActivity = Date.now(); });
  };
  const visible = () => { if (document.visibilityState === "visible") connect(); };
  const timer = setInterval(() => {
    if (document.visibilityState !== "hidden" && Date.now() - lastActivity > 45_000) connect();
  }, 10_000);
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("online", connect);
  connect();
  return () => {
    disposed = true;
    source?.close();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", visible);
    window.removeEventListener("online", connect);
  };
}

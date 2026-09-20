import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/queryClient";
import { ADMIN_TOPICS, type AdminTopic } from "@shared/admin-data";
import { ADMIN_POLL_MS, affectedByTopics, isAdminDataKey, refreshAdminData } from "@/lib/admin-freshness";

// Exactly one instance, mounted only in the authenticated administrative shell.
export function AdminDataSync() {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState({ errors: false, pending: true, oldest: 0 });
  useEffect(() => {
    const update = () => {
      const queries = client.getQueryCache().findAll({ type: "active", predicate: (q) => isAdminDataKey(q.queryKey) });
      const dates = queries.map((q) => q.state.dataUpdatedAt).filter(Boolean);
      const next = {
        errors: queries.some((q) => q.state.status === "error"),
        pending: queries.some((q) => q.state.status === "pending"),
        oldest: dates.length ? Math.min(...dates) : 0,
      };
      setHealth((prev) => prev.errors === next.errors && prev.pending === next.pending && prev.oldest === next.oldest ? prev : next);
    };
    const unsubscribe = client.getQueryCache().subscribe(update);
    update();
    let es: EventSource;
    let lastSignal = Date.now();
    const open = () => {
      es = new EventSource(`${API_BASE}/api/admin/events`, { withCredentials: true });
      es.onopen = () => { lastSignal = Date.now(); setConnected(true); void refreshAdminData(client, true); };
      es.addEventListener("heartbeat", () => { lastSignal = Date.now(); });
      es.onmessage = (event) => {
        lastSignal = Date.now();
        try {
          const body = JSON.parse(event.data);
          const topics = Array.isArray(body.topics)
            ? body.topics.filter((t: AdminTopic) => ADMIN_TOPICS.includes(t)) as AdminTopic[] : [];
          void client.invalidateQueries({ predicate: (q) => affectedByTopics(q.queryKey, topics) });
        } catch { /* A malformed event cannot poison query data. Polling recovers. */ }
      };
      es.onerror = () => setConnected(false);
    };
    open();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshAdminData(client);
      if (Date.now() - lastSignal > 75_000) {
        es.close(); setConnected(false); lastSignal = Date.now(); open();
      }
    }, ADMIN_POLL_MS);
    const recover = () => {
      if (document.visibilityState === "visible") void refreshAdminData(client, true);
    };
    window.addEventListener("online", recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      unsubscribe(); es.close(); clearInterval(timer);
      window.removeEventListener("online", recover);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [client]);

  return (
    <div role="status" className={`px-4 lg:px-10 py-2 text-xs flex flex-wrap items-center gap-3 border-b ${health.errors ? "text-destructive bg-destructive/5" : "text-muted-foreground"}`} data-testid="admin-data-status">
      <span>{health.errors ? "Не удалось обновить часть данных. Значения могут быть устаревшими."
        : health.pending ? "Загрузка данных с сервера…"
        : connected ? "Обновление в реальном времени"
        : "Связь с каналом событий потеряна. Работает резервное обновление."}</span>
      {health.oldest > 0 && <span>Данные от {new Date(health.oldest).toLocaleTimeString("ru-RU")}</span>}
      <button className="underline" onClick={() => void refreshAdminData(client, true)}>Обновить</button>
    </div>
  );
}

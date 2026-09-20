import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/queryClient";
import { ADMIN_TOPICS, type AdminTopic } from "@shared/admin-data";
import { ADMIN_POLL_MS, affectedByTopics, refreshAdminData } from "@/lib/admin-freshness";

// Exactly one instance, mounted only in the authenticated administrative shell.
export function AdminDataSync() {
  const client = useQueryClient();
  useEffect(() => {
    let es: EventSource;
    let lastSignal = Date.now();
    const open = () => {
      es = new EventSource(`${API_BASE}/api/admin/events`, { withCredentials: true });
      es.onopen = () => { lastSignal = Date.now(); void refreshAdminData(client, true); };
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
    };
    open();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshAdminData(client);
      if (Date.now() - lastSignal > 75_000) {
        es.close(); lastSignal = Date.now(); open();
      }
    }, ADMIN_POLL_MS);
    const recover = () => {
      if (document.visibilityState === "visible") void refreshAdminData(client, true);
    };
    window.addEventListener("online", recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      es.close(); clearInterval(timer);
      window.removeEventListener("online", recover);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [client]);

  // Synchronization stays mounted, but does not occupy space in the layout.
  return null;
}

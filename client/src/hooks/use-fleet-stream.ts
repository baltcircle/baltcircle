import { useEffect } from "react";
import { API_BASE, queryClient } from "@/lib/queryClient";

let sharedStream: EventSource | null = null;
let subscribers = 0;

// Подписка на SSE-стрим флота (/api/bikes/stream). Сервер шлёт "tick" при
// любом изменении статуса/набора велосипедов (старт/конец аренды, бронь,
// правки из админки). По событию инвалидируем оба списка велосипедов, чтобы
// открытые страницы обновлялись сразу, а не по таймеру (глобальный
// staleTime:Infinity сам обновления не делает).
export function useFleetStream() {
  useEffect(() => {
    subscribers += 1;
    if (!sharedStream) {
      const es = new EventSource(`${API_BASE}/api/bikes/stream`);
      sharedStream = es;
      es.onmessage = () => {
        queryClient.invalidateQueries({ queryKey: ["/api/admin/bikes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
        // Старт/конец аренды меняет и список поездок, и счётчики вкладок.
        queryClient.invalidateQueries({ queryKey: ["/api/admin/rides"] });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/ride-stats"] });
        // «Занято» парковок считается от велосипедов → обновляем и их.
        queryClient.invalidateQueries({ queryKey: ["/api/parkings"] });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/parkings"] });
        queryClient.invalidateQueries({ queryKey: ["/api/admin/alerts"] });
      };
      es.onerror = () => {}; // EventSource переподключится сам.
    }
    return () => {
      subscribers -= 1;
      if (subscribers === 0) { sharedStream?.close(); sharedStream = null; }
    };
  }, []);
}

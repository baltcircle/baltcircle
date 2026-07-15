import { useEffect } from "react";
import { API_BASE, queryClient } from "@/lib/queryClient";

// Подписка на SSE-стрим флота (/api/bikes/stream). Сервер шлёт "tick" при
// любом изменении статуса/набора велосипедов (старт/конец аренды, бронь,
// правки из админки). По событию инвалидируем оба списка велосипедов, чтобы
// открытые страницы обновлялись сразу, а не по таймеру (глобальный
// staleTime:Infinity сам обновления не делает).
export function useFleetStream() {
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/bikes/stream`);
    es.onmessage = () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/bikes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      // «Занято» парковок считается от велосипедов → обновляем и их.
      queryClient.invalidateQueries({ queryKey: ["/api/parkings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/parkings"] });
    };
    es.onerror = () => {}; // EventSource переподключится сам.
    return () => es.close();
  }, []);
}

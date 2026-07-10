import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Ride } from "@shared/schema";
import { realToMap } from "@shared/geo";
import { apiRequest, queryClient } from "@/lib/queryClient";

/**
 * Реальный GPS-трекер активной аренды.
 *
 * Заменяет симулятор: точки на сервер приходят из настоящего GPS пользователя.
 * MapLibreMap уже держит подписку на watchPosition; MapPage прокидывает
 * координаты сюда через onUserLocation, а этот хук:
 *   1) Троттлит апдейты (>= 3s между отправками)
 *   2) Отсеивает дребезг (< 5m от последней сохранённой точки)
 *   3) Конвертирует lat/lng в абстрактное map-space через realToMap()
 *      — сервер считает distanceM в map units × 30, поэтому геометрия важна.
 */
export function useActiveRideTracker(ride: Ride | null | undefined) {
  const lastSentRef = useRef<{ lat: number; lng: number; t: number } | null>(null);

  const pointMut = useMutation({
    mutationFn: async (p: { x: number; y: number }) => {
      if (!ride) throw new Error("no active ride");
      const res = await apiRequest("POST", `/api/rides/${ride.id}/point`, p);
      return res.json() as Promise<Ride>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
    },
  });

  // Каждая новая аренда — обнуляем историю (иначе первый апдейт нафильтруется).
  useEffect(() => {
    lastSentRef.current = null;
  }, [ride?.id]);

  const push = (lat: number, lng: number) => {
    if (!ride) return;
    const now = Date.now();
    const last = lastSentRef.current;
    if (last) {
      const dt = now - last.t;
      if (dt < 3000) return; // троттл
      const dm = haversineM(last.lat, last.lng, lat, lng);
      if (dm < 5) return; // дребезг GPS
    }
    const mp = realToMap(lat, lng);
    lastSentRef.current = { lat, lng, t: now };
    pointMut.mutate({ x: mp.x, y: mp.y });
  };

  return { push };
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Parking, Ride } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";

/**
 * Симулятор движения велосипеда во время активной аренды.
 *
 * Раньше эта логика жила в ActiveRidePanel и работала только пока пользователь
 * находился на странице /rent. Теперь мы вынесли её в хук: MapPage подключает
 * его один раз при активной поездке, и симуляция продолжается независимо от
 * того, на карте юзер или на overlay-странице.
 *
 * Каждые ~2.2s хук берёт последнюю точку трека и делает шаг в сторону
 * случайно выбранной парковки-цели. При приближении на <6 у.е. цель меняется.
 * После каждого шага сервер пересчитывает пройденное расстояние и стоимость,
 * и все клиенты получают обновление через SSE (см. use-active-ride-stream).
 */
export function useActiveRideSimulator(ride: Ride | null | undefined, parkings: Parking[] | undefined) {
  const targetRef = useRef<{ x: number; y: number } | null>(null);

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

  // Выбираем начальную цель, когда пришли парковки
  useEffect(() => {
    if (parkings && parkings.length > 0 && !targetRef.current) {
      const t = parkings[Math.floor(Math.random() * parkings.length)];
      targetRef.current = { x: t.lng, y: t.lat };
    }
  }, [parkings]);

  useEffect(() => {
    if (!ride) return;
    let cancelled = false;

    const tick = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 2200));
        if (cancelled) break;
        const last = lastPoint(ride);
        const tgt = targetRef.current;
        if (!last || !tgt) continue;

        const dx = tgt.x - last[0];
        const dy = tgt.y - last[1];
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 6) {
          const arr = parkings ?? [];
          if (arr.length) {
            const next = arr[Math.floor(Math.random() * arr.length)];
            targetRef.current = { x: next.lng, y: next.lat };
          }
          continue;
        }

        const step = Math.min(20, dist);
        const nx = last[0] + (dx / dist) * step + (Math.random() - 0.5) * 4;
        const ny = last[1] + (dy / dist) * step + (Math.random() - 0.5) * 4;
        pointMut.mutate({ x: nx, y: ny });
      }
    };
    tick();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride?.id, parkings]);
}

function lastPoint(ride: Ride): [number, number, number] | null {
  try {
    const pts = JSON.parse(ride.track) as [number, number, number][];
    return pts[pts.length - 1] ?? null;
  } catch {
    return null;
  }
}

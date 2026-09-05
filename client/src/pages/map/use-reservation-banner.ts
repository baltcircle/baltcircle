import { useMutation, useQuery } from "@tanstack/react-query";
import type { Reservation } from "@shared/schema";
import { apiRequest, errorMessage, queryClient } from "@/lib/queryClient";
import { RESERVATION_ACTIVE_KEY } from "@/lib/payment";
import { useToast } from "@/hooks/use-toast";

/**
 * Баннеры активных броней («Начать аренду» → «Бронь»). Единственный источник
 * правды по времени — `expiresAt` с сервера: countdown в ReservationCountdown
 * тикает локально и прячет свою карточку по достижении нуля сам, без опроса —
 * сервер догонит той же сделкой в фоновом sweep (server/index.ts, каждые 60с).
 *
 * До MAX_ACTIVE_RIDES_PER_USER (shared/geo.ts) активных броней одновременно —
 * бронь и активная поездка делят один общий лимит, поэтому запрос НЕ гасится
 * наличием активной поездки: рядер может держать поездку на одном велосипеде
 * и бронь на другом одновременно, и должен видеть баннер брони в обоих
 * случаях. use-active-ride-stream.tsx инвалидирует этот кэш на каждое
 * изменение активных поездок (старт claim'ит бронь, конец освобождает бюджет).
 */
export function useReservationBanner(isRegistered: boolean) {
  const toast = useToast();
  const reservationsQ = useQuery<Reservation[]>({
    queryKey: RESERVATION_ACTIVE_KEY,
    enabled: isRegistered,
  });

  const cancelMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/reservations/${id}/cancel`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RESERVATION_ACTIVE_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      toast.toast({ title: "Бронь отменена" });
    },
    onError: (err) => {
      toast.toast({
        title: "Не удалось отменить бронь",
        description: errorMessage(err, "Попробуйте ещё раз"),
        variant: "destructive",
      });
    },
  });

  // Once a local countdown hits zero that ONE reservation is stale by
  // definition (the server's own clock will agree within seconds) — drop
  // just that row from the cached array immediately so the UI doesn't wait
  // for the next invalidation/mount to catch up. Leaves any other active
  // reservation in the list untouched.
  const onExpire = (id: number) => {
    queryClient.setQueryData<Reservation[]>(
      RESERVATION_ACTIVE_KEY,
      (prev) => (prev ?? []).filter((r) => r.id !== id),
    );
  };

  return {
    reservations: reservationsQ.data ?? [],
    cancelling: cancelMut.isPending,
    cancelReservation: (id: number) => cancelMut.mutate(id),
    onExpire,
  };
}

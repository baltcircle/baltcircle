import { useMutation, useQuery } from "@tanstack/react-query";
import type { Reservation } from "@shared/schema";
import { apiRequest, errorMessage, queryClient } from "@/lib/queryClient";
import { RESERVATION_ACTIVE_KEY } from "@/lib/payment";
import { useToast } from "@/hooks/use-toast";

/**
 * Баннер активной брони («Начать аренду» → «Бронь»). Единственный источник
 * правды по времени — `expiresAt` с сервера: countdown в ReservationCountdown
 * тикает локально и прячет баннер по достижении нуля сам, без опроса — сервер
 * догонит той же сделкой в фоновом sweep (server/index.ts, каждые 60с).
 *
 * Запрос включён только когда рядер зарегистрирован и у него нет активной
 * поездки — как только поездка стартует (в т.ч. через сканирование ЭТОГО же
 * забронированного велосипеда), MapPage переключается на ActiveRideCard и
 * баннер брони перестаёт монтироваться сам по себе.
 */
export function useReservationBanner(isRegistered: boolean, hasActiveRide: boolean) {
  const toast = useToast();
  const reservationQ = useQuery<Reservation | null>({
    queryKey: RESERVATION_ACTIVE_KEY,
    enabled: isRegistered && !hasActiveRide,
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

  // Once the local countdown hits zero the row is stale by definition (the
  // server's own clock will agree within seconds) — drop it from the cache
  // immediately so the UI doesn't wait for the next poll/mount to catch up.
  const onExpire = () => {
    queryClient.setQueryData(RESERVATION_ACTIVE_KEY, null);
  };

  return {
    reservation: reservationQ.data ?? null,
    cancelling: cancelMut.isPending,
    cancelReservation: (id: number) => cancelMut.mutate(id),
    onExpire,
  };
}

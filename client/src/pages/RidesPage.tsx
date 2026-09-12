import { useQuery } from "@tanstack/react-query";
import { OverlayShell } from "@/components/OverlayShell";
import type { RideWithFeedback } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { fmtDateFull, fmtDistanceKm, fmtTimeOnly, fmtRub, fmtRideTariff } from "@/lib/format";
import { apiRequest } from "@/lib/queryClient";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Route } from "lucide-react";

export function RidesPage() {
  // История поездок — приватные данные конкретного пользователя. Гостям её не
  // показываем: без входа нет «своих» поездок, а seeded demo-аккаунт — общий
  // для всех неавторизованных, показывать его историю в личном кабинете нельзя
  // (privacy leak). Авторизованным поездки подтягиваются из БД по их userId.
  const { user, isRegistered, isLoading: isAuthLoading } = useCurrentUser();
  const userId = user?.id;

  const ridesQ = useQuery<RideWithFeedback[]>({
    queryKey: ["/api/rides", { userId, limit: 40 }],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/rides?userId=${encodeURIComponent(userId!)}&limit=40`);
      return res.json();
    },
    enabled: isRegistered && !!userId,
  });

  // Пока не знаем, авторизован ли пользователь (первый рендер до ответа на
  // /api/users/current) — держим пустой контейнер, чтобы не мигать между
  // приглашением войти и списком.
  if (isAuthLoading) {
    return (
      <OverlayShell title="История поездок">
        <div className="px-4 py-6 max-w-2xl mx-auto" data-testid="page-rides" />
      </OverlayShell>
    );
  }

  if (!isRegistered) {
    return (
      <OverlayShell title="История поездок">
        <div className="px-4 py-6 max-w-2xl mx-auto" data-testid="page-rides">
          <Card className="p-10 text-center" data-testid="empty-rides-guest">
            <Route className="w-10 h-10 mx-auto opacity-40 mb-3" />
            <div className="font-display text-lg font-light mb-1">История доступна после входа</div>
            <div className="text-sm text-muted-foreground mb-6">
              Войдите в аккаунт, чтобы видеть свои завершённые поездки, дистанцию и стоимость.
            </div>
          </Card>
        </div>
      </OverlayShell>
    );
  }

  const rides = ridesQ.data ?? [];
  const isLoadingRides = ridesQ.isLoading;

  return (
    <OverlayShell title="История поездок">
      <div className="px-4 py-6 max-w-2xl mx-auto" data-testid="page-rides">
        {isLoadingRides && (
          <Card className="p-10 text-center text-muted-foreground" data-testid="loading-rides">
            <div>Загружаем историю…</div>
          </Card>
        )}

        {!isLoadingRides && rides.length === 0 && (
          <Card className="p-10 text-center text-muted-foreground" data-testid="empty-rides">
            <Route className="w-10 h-10 mx-auto opacity-40 mb-3" />
            <div>Пока нет завершённых поездок.</div>
          </Card>
        )}

        <div className="space-y-3">
          {rides.map(r => (
            <Card key={r.id} className="p-4 lg:p-5" data-testid={`row-ride-${r.id}`}>
              <div
                className="text-center text-base font-bold mb-2"
                data-testid={`text-ride-date-${r.id}`}
              >
                {fmtDateFull(r.startedAt)}
              </div>
              <div className="flex items-center justify-between gap-3">
                {r.endedAt != null ? (
                  <div
                    className="grid grid-cols-[auto_auto_auto] gap-x-1.5"
                    data-testid={`text-ride-time-${r.id}`}
                  >
                    <span className="font-medium text-center">{fmtTimeOnly(r.startedAt)}</span>
                    <span className="font-medium text-center">–</span>
                    <span className="font-medium text-center">{fmtTimeOnly(r.endedAt)}</span>
                    <span className="text-xs text-muted-foreground text-center">{fmtDistanceKm(r.distanceM)}</span>
                    <span className="text-xs text-muted-foreground text-center">·</span>
                    <span className="text-xs text-muted-foreground text-center">{r.bikeId}</span>
                  </div>
                ) : (
                  <div className="min-w-0" data-testid={`text-ride-time-${r.id}`}>
                    <div className="font-medium">с {fmtTimeOnly(r.startedAt)}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {fmtDistanceKm(r.distanceM)} · {r.bikeId}
                    </div>
                  </div>
                )}
                <div className="flex flex-col items-end shrink-0">
                  <span className="font-medium" data-testid={`text-ride-tariff-${r.id}`}>
                    {fmtRideTariff(r)}
                  </span>
                  <span className="font-medium" data-testid={`text-ride-cost-${r.id}`}>
                    {fmtRub(r.cost)}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </OverlayShell>
  );
}

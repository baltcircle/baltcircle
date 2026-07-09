import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { OverlayShell } from "@/components/OverlayShell";
import type { Ride } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtDate, fmtDistance, fmtDuration, fmtRub, fmtTariff } from "@/lib/format";
import { apiRequest } from "@/lib/queryClient";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Route, Clock, MapPin, Receipt, LogIn } from "lucide-react";

export function RidesPage() {
  // История поездок — приватные данные конкретного пользователя. Гостям её не
  // показываем: без входа нет «своих» поездок, а seeded demo-аккаунт — общий
  // для всех неавторизованных, показывать его историю в личном кабинете нельзя
  // (privacy leak). Авторизованным поездки подтягиваются из БД по их userId.
  const { user, isRegistered, isLoading: isAuthLoading } = useCurrentUser();
  const userId = user?.id;

  const ridesQ = useQuery<Ride[]>({
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
            <Link href="/settings">
              <Button data-testid="button-login-from-rides" className="gap-2">
                <LogIn className="w-4 h-4" /> Войти
              </Button>
            </Link>
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
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <div className="font-display text-lg font-light" data-testid={`text-ride-bike-${r.id}`}>{r.bikeId}</div>
                  <div className="text-xs text-muted-foreground">{fmtDate(r.startedAt)}</div>
                </div>
                <div className="flex-1 grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
                  <Cell icon={<Clock className="w-3.5 h-3.5" />} label="Время" value={r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : "Активна"} />
                  <Cell icon={<MapPin className="w-3.5 h-3.5" />} label="Дистанция" value={fmtDistance(r.distanceM)} />
                  <Cell icon={<Route className="w-3.5 h-3.5" />} label="Тариф" value={fmtTariff(r.tariff)} />
                  <Cell icon={<Receipt className="w-3.5 h-3.5" />} label="Стоимость" value={fmtRub(r.cost)} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </OverlayShell>
  );
}

function Cell({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1">{icon}{label}</div>
      <div className="font-display font-light mt-0.5">{value}</div>
    </div>
  );
}

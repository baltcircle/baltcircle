import { useQuery } from "@tanstack/react-query";
import { OverlayShell } from "@/components/OverlayShell";
import type { Ride } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { fmtDate, fmtDistance, fmtDuration, fmtRub, fmtTariff } from "@/lib/format";
import { apiRequest } from "@/lib/queryClient";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Route, Clock, MapPin, Receipt } from "lucide-react";

export function RidesPage() {
  // Show the signed-in rider's own history; guests fall back to the seeded
  // "demo" account so the public MVP still shows sample rides.
  const { user } = useCurrentUser();
  const userId = user?.id ?? "demo";

  const ridesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides", { userId, limit: 40 }],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/rides?userId=${encodeURIComponent(userId)}&limit=40`);
      return res.json();
    },
  });

  const rides = ridesQ.data ?? [];

  return (
    <OverlayShell title="История поездок">
      <div className="px-4 py-6 max-w-2xl mx-auto" data-testid="page-rides">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">История</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Ваши поездки</h1>
      </header>

      {rides.length === 0 && (
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
  );
}

function Cell({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground flex items-center gap-1">{icon}{label}</div>
      <div className="font-display font-light mt-0.5">{value}</div>
          </div>
    </OverlayShell>
  );
}

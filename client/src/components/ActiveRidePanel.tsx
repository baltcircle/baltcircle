import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Bike, Parking, ZoneRow, Ride } from "@shared/schema";
import { CoastMap } from "./CoastMap";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { fmtDistance, fmtDuration, fmtRub, fmtTariff } from "@/lib/format";
import { Pause, Lock, MapPin, AlertTriangle, Sparkles, Gauge } from "lucide-react";
import { checkZoneState } from "@shared/geo";
import { useToast } from "@/hooks/use-toast";

export function ActiveRidePanel({ ride }: { ride: Ride }) {
  const toast = useToast();
  const parkings = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  const zones = useQuery<ZoneRow[]>({ queryKey: ["/api/zones"] });
  const bikes = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const [now, setNow] = useState(Date.now());

  const elapsed = now - ride.startedAt;

  const targetRef = useRef<{ x: number; y: number } | null>(null);

  // Pick a target parking once
  useEffect(() => {
    if (parkings.data && !targetRef.current) {
      const t = parkings.data[Math.floor(Math.random() * parkings.data.length)];
      targetRef.current = { x: t.lng, y: t.lat };
    }
  }, [parkings.data]);

  const pointMut = useMutation({
    mutationFn: async (p: { x: number; y: number }) => {
      const res = await apiRequest("POST", `/api/rides/${ride.id}/point`, p);
      return res.json() as Promise<Ride>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
    },
  });

  const endMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/rides/${ride.id}/end`);
      return res.json() as Promise<Ride>;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rides"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      toast.toast({
        title: "Поездка завершена",
        description: `${fmtDistance(r.distanceM)} • ${fmtRub(r.cost)}`,
      });
    },
  });

  // Tick clock and move the bike toward target
  useEffect(() => {
    let cancelled = false;
    const tickClock = setInterval(() => setNow(Date.now()), 1000);

    const move = async () => {
      while (!cancelled) {
        await new Promise(r => setTimeout(r, 2200));
        if (cancelled) break;
        const last = lastPoint(ride);
        const tgt = targetRef.current;
        if (!last || !tgt) continue;
        const dx = tgt.x - last[0], dy = tgt.y - last[1];
        const dist = Math.sqrt(dx*dx+dy*dy);
        if (dist < 6) {
          // pick a new target
          const arr = parkings.data ?? [];
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
    move();
    return () => { cancelled = true; clearInterval(tickClock); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride.id, parkings.data]);

  const last = lastPoint(ride);
  const zoneState = last ? checkZoneState(last[0], last[1]) : null;
  const speedKmh = 14 + Math.round(Math.sin(now / 4000) * 4);

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-6xl mx-auto" data-testid="page-active-ride">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Активная поездка</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1" data-testid="text-active-bike">{ride.bikeId}</h1>
        </div>
        <Badge variant="default" className="ride-pulse bg-accent text-accent-foreground" data-testid="badge-live">● В пути</Badge>
      </header>

      <div className="grid lg:grid-cols-[1fr_360px] gap-5">
        <CoastMap
          bikes={bikes.data ?? []}
          parkings={parkings.data ?? []}
          zones={zones.data ?? []}
          ride={ride}
          height="60vh"
          showLabels={false}
          interactive={false}
        />

        <div className="space-y-4">
          <Card className="p-5">
            <div className="grid grid-cols-3 gap-2 text-center">
              <Big label="Время" value={fmtDuration(elapsed)} testId="text-ride-duration" />
              <Big label="Расстояние" value={fmtDistance(ride.distanceM)} testId="text-ride-distance" />
              <Big label="К оплате" value={fmtRub(ride.cost)} testId="text-ride-cost" />
            </div>
          </Card>

          <Card className="p-5 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-muted-foreground"><Gauge className="w-4 h-4" />Скорость</span>
              <span className="font-display text-base font-light" data-testid="text-ride-speed">{speedKmh} км/ч</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-muted-foreground"><MapPin className="w-4 h-4" />Зона</span>
              <span className={`font-display font-light ${zoneState?.kind === "forbidden" ? "text-destructive" : zoneState?.kind === "slow" ? "text-amber-600 dark:text-amber-400" : zoneState?.kind === "out" ? "text-amber-600 dark:text-amber-400" : ""}`}>
                {zoneState?.name ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-muted-foreground"><Sparkles className="w-4 h-4" />Тариф</span>
              <span className="font-display font-light">{fmtTariff(ride.tariff)}</span>
            </div>
          </Card>

          {zoneState && zoneState.kind !== "ok" && (
            <Card className="p-4 bg-destructive/10 border-destructive/30" data-testid="alert-ride-zone">
              <div className="flex items-start gap-2 text-destructive text-sm">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">
                    {zoneState.kind === "forbidden"
                      ? "Вы в запрещённой зоне! Замок будет заблокирован."
                      : zoneState.kind === "out"
                      ? "Вы выехали за пределы зоны обслуживания."
                      : "Ограничение скорости — 15 км/ч."}
                  </div>
                  <div className="opacity-80 mt-1 text-xs">{zoneState.name}</div>
                </div>
              </div>
            </Card>
          )}

          <Button
            variant="outline"
            className="w-full"
            disabled={endMut.isPending}
            data-testid="button-end-ride"
            onClick={() => endMut.mutate()}
          >
            <Lock className="w-4 h-4 mr-2" />
            Завершить поездку
          </Button>
        </div>
      </div>
    </div>
  );
}

function lastPoint(ride: Ride): [number, number, number] | null {
  try {
    const pts = JSON.parse(ride.track) as [number, number, number][];
    return pts[pts.length - 1] ?? null;
  } catch { return null; }
}
function Big({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="font-display text-xl font-light mt-1" data-testid={testId}>{value}</div>
    </div>
  );
}

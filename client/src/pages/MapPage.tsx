import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import type { Bike, Parking, ZoneRow, Ride } from "@shared/schema";
import { KaliningradMap } from "@/components/KaliningradMap";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Battery, Bike as BikeIcon, MapPin, QrCode, Sparkles, AlertTriangle } from "lucide-react";
import { fmtRelative } from "@/lib/format";
import { checkZoneState } from "@shared/geo";

export function MapPage() {
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  const zonesQ = useQuery<ZoneRow[]>({ queryKey: ["/api/zones"] });
  const rideQ = useQuery<Ride | null>({ queryKey: ["/api/rides/active"], refetchInterval: 4000 });

  const [selected, setSelected] = useState<string | null>(null);

  const bike = useMemo(
    () => bikesQ.data?.find(b => b.id === selected) ?? null,
    [selected, bikesQ.data]
  );

  const availableBikes = useMemo(
    () => bikesQ.data?.filter(b => b.status === "available") ?? [],
    [bikesQ.data]
  );

  useEffect(() => {
    if (!selected && availableBikes[0]) setSelected(availableBikes[0].id);
  }, [availableBikes, selected]);

  const zoneState = bike ? checkZoneState(bike.lng, bike.lat) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Hero strip with sea+sand brand pattern */}
      <div className="relative bg-primary text-primary-foreground px-6 py-6 lg:px-10 lg:py-7 overflow-hidden">
        <div className="relative z-10 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] opacity-80">Калининград · сейчас</div>
            <h1 className="font-display text-2xl lg:text-[28px] mt-1 font-light tracking-tight">
              Где ваш велосипед — рядом
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <StatPill label="Доступно" value={availableBikes.length.toString()} />
            <StatPill label="В аренде" value={(bikesQ.data?.filter(b => b.status === "rented").length ?? 0).toString()} />
            <StatPill label="Станций" value={(parkingsQ.data?.length ?? 0).toString()} />
          </div>
        </div>
        {/* sand wave at bottom */}
        <svg viewBox="0 0 1200 40" preserveAspectRatio="none" className="absolute bottom-0 left-0 w-full h-5 text-background block" aria-hidden="true">
          <path d="M0 40 V18 C200 40 400 0 600 18 S1000 40 1200 18 V40 Z" fill="currentColor" />
        </svg>
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-4 lg:gap-6 px-4 lg:px-10 py-6 lg:py-8">
        <div>
          <KaliningradMap
            bikes={bikesQ.data ?? []}
            parkings={parkingsQ.data ?? []}
            zones={zonesQ.data ?? []}
            ride={rideQ.data ?? null}
            selectedBikeId={selected}
            onSelectBike={setSelected}
            height="60vh"
            showLabels={false}
          />
          <LegendRow />
        </div>

        {/* Side panel */}
        <Card className="p-5 self-start sticky top-4" data-testid="card-bike-detail">
          {!bike ? (
            <div className="text-sm text-muted-foreground">Выберите велосипед на карте.</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Велосипед</div>
                  <h2 className="font-display text-xl font-light" data-testid="text-bike-id">{bike.id}</h2>
                  <div className="text-sm text-muted-foreground">{bike.model}</div>
                </div>
                <StatusBadge status={bike.status} />
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <Tile icon={<Battery className="w-4 h-4" />} label="Заряд замка" value={`${bike.battery}%`} tone={bike.battery < 25 ? "danger" : bike.battery < 50 ? "warn" : "ok"} />
                <Tile icon={<MapPin className="w-4 h-4" />} label="Простой" value={bike.idleHours.toFixed(1) + " ч"} tone={bike.idleHours > 60 ? "warn" : "ok"} />
                <Tile icon={<BikeIcon className="w-4 h-4" />} label="Последний сигнал" value={fmtRelative(bike.lastSeen)} />
                <Tile icon={<Sparkles className="w-4 h-4" />} label="Зона" value={zoneState?.kind === "ok" ? "Рабочая" : zoneState?.kind === "slow" ? "Тихая" : zoneState?.kind === "forbidden" ? "Запрещена" : "Вне сервиса"} tone={zoneState?.kind === "forbidden" ? "danger" : zoneState?.kind === "out" ? "warn" : zoneState?.kind === "slow" ? "warn" : "ok"} />
              </div>

              {zoneState && zoneState.kind !== "ok" && (
                <div className="flex items-start gap-2 rounded-md bg-destructive/10 text-destructive p-3 text-xs" data-testid="alert-zone">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <div className="font-medium">{zoneState.kind === "forbidden" ? "Запрещённая зона" : zoneState.kind === "out" ? "Вне зоны обслуживания" : "Ограниченная зона"}</div>
                    <div className="opacity-80">{zoneState.name}</div>
                  </div>
                </div>
              )}

              <Link href={`/rent?bike=${bike.id}`} data-testid="link-rent-from-map">
                <Button
                  className="w-full"
                  disabled={bike.status !== "available"}
                  data-testid="button-rent-bike"
                >
                  <QrCode className="w-4 h-4 mr-2" />
                  Арендовать
                </Button>
              </Link>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-white/10 backdrop-blur px-3 py-2 text-center" data-testid={`stat-${label}`}>
      <div className="text-[10px] uppercase tracking-widest opacity-80">{label}</div>
      <div className="font-display text-lg font-light">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    available: { label: "Доступен", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" },
    rented: { label: "В аренде", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" },
    reserved: { label: "Бронь", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" },
    maintenance: { label: "На сервисе", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200" },
    offline: { label: "Оффлайн", cls: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200" },
  };
  const v = map[status] ?? map.offline;
  return <Badge className={`${v.cls} border-0`} data-testid={`badge-status-${status}`}>{v.label}</Badge>;
}

function Tile({ icon, label, value, tone = "neutral" }: {
  icon: React.ReactNode; label: string; value: string;
  tone?: "neutral" | "ok" | "warn" | "danger";
}) {
  const toneCls = tone === "danger" ? "text-destructive" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "";
  return (
    <div className="rounded-md border border-card-border bg-card/40 p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">{icon} {label}</div>
      <div className={`font-display text-base mt-1 font-light ${toneCls}`}>{value}</div>
    </div>
  );
}

function LegendRow() {
  return (
    <div className="flex flex-wrap items-center gap-3 mt-3 text-xs text-muted-foreground" data-testid="map-legend">
      <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />Доступен</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-primary" />В аренде</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500" />Бронь</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500" />Сервис</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-amber-300/60 border border-amber-500/60" />Ограничение 15 км/ч</span>
      <span className="inline-flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-rose-300/40 border border-rose-500/60" />Запрещённая зона</span>
    </div>
  );
}

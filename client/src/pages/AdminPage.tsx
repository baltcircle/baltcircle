import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import type { Bike } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search, Battery, Clock, MapPin, Bike as BikeIcon, AlertTriangle, Settings2 } from "lucide-react";
import { fmtRelative } from "@/lib/format";
import { checkZoneState } from "@shared/geo";

type StatusFilter = "all" | "available" | "rented" | "reserved" | "maintenance" | "offline";

export function AdminPage() {
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  const bikes = bikesQ.data ?? [];
  const filtered = useMemo(() => bikes.filter(b => {
    if (filter !== "all" && b.status !== filter) return false;
    if (search && !b.id.toLowerCase().includes(search.toLowerCase()) &&
        !b.model.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [bikes, filter, search]);

  const counts: Record<StatusFilter, number> = {
    all: bikes.length,
    available: bikes.filter(b => b.status === "available").length,
    rented: bikes.filter(b => b.status === "rented").length,
    reserved: bikes.filter(b => b.status === "reserved").length,
    maintenance: bikes.filter(b => b.status === "maintenance").length,
    offline: bikes.filter(b => b.status === "offline").length,
  };

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Парк</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1" data-testid="text-fleet-count">
            {bikes.length} {pluralBikes(bikes.length)}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Статусы, заряд замков, простой и последний сигнал по всему флоту.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск BC-014 или модель"
              className="pl-9 w-64"
              data-testid="input-admin-search"
            />
          </div>
          <Link href="/admin/bikes" data-testid="link-manage-bikes">
            <Button variant="outline"><Settings2 className="w-4 h-4 mr-2" />Управление</Button>
          </Link>
        </div>
      </header>

      {/* Status filter pills */}
      <div className="flex flex-wrap gap-2 mb-5" data-testid="admin-filters">
        {(["all","available","rented","reserved","maintenance","offline"] as StatusFilter[]).map(s => (
          <Button
            key={s}
            variant={filter === s ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(s)}
            data-testid={`button-filter-${s}`}
          >
            {filterLabel(s)} <span className="ml-2 opacity-70">{counts[s]}</span>
          </Button>
        ))}
      </div>

      <Card className="overflow-hidden" data-testid="table-bikes">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">ID</TableHead>
              <TableHead>Модель</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead><Battery className="w-3.5 h-3.5 inline mr-1" />Замок</TableHead>
              <TableHead><Clock className="w-3.5 h-3.5 inline mr-1" />Простой</TableHead>
              <TableHead><MapPin className="w-3.5 h-3.5 inline mr-1" />Зона</TableHead>
              <TableHead>Сигнал</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map(b => {
              const z = checkZoneState(b.lng, b.lat);
              return (
                <TableRow key={b.id} data-testid={`row-bike-${b.id}`} className="hover-elevate">
                  <TableCell className="font-mono text-sm">
                    <span className="inline-flex items-center gap-2"><BikeIcon className="w-3.5 h-3.5 text-muted-foreground" />{b.id}</span>
                  </TableCell>
                  <TableCell className="text-sm">{b.model}</TableCell>
                  <TableCell><StatusPill status={b.status} /></TableCell>
                  <TableCell><BatteryBar pct={b.battery} /></TableCell>
                  <TableCell className={b.idleHours > 60 ? "text-amber-600 dark:text-amber-400" : ""}>
                    {b.idleHours.toFixed(1)} ч
                  </TableCell>
                  <TableCell>
                    {z.kind === "ok" ? (
                      <span className="text-muted-foreground text-sm">В норме</span>
                    ) : (
                      <Badge variant="outline" className={z.kind === "forbidden" ? "text-destructive border-destructive/40" : "text-amber-600 dark:text-amber-400 border-amber-500/40"}>
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        {z.kind === "forbidden" ? "Запрет" : z.kind === "slow" ? "Тихая" : "Вне зоны"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtRelative(b.lastSeen)}</TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-12">Велосипедов не найдено</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function pluralBikes(n: number) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "велосипед";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "велосипеда";
  return "велосипедов";
}

function filterLabel(s: StatusFilter) {
  return ({
    all: "Все",
    available: "Доступен",
    rented: "В аренде",
    reserved: "Бронь",
    maintenance: "Сервис",
    offline: "Оффлайн",
  } as const)[s];
}

function StatusPill({ status }: { status: string }) {
  const m: Record<string, string> = {
    available: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    rented: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
    reserved: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    maintenance: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
    offline: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
    storage: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200",
    lost: "bg-rose-200 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
    archived: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  };
  const labels: Record<string, string> = {
    available: "Доступен", rented: "В аренде", reserved: "Бронь",
    maintenance: "Сервис", offline: "Оффлайн", storage: "На складе",
    lost: "Утерян", archived: "Архив",
  };
  return <Badge className={`${m[status] ?? m.offline} border-0`}>{labels[status] ?? status}</Badge>;
}

function BatteryBar({ pct }: { pct: number }) {
  const tone = pct < 20 ? "bg-rose-500" : pct < 45 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="text-xs font-mono w-9 text-right">{pct}%</span>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "wouter";
import type { Bike, User, Ride, Ticket, MapObject } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtRelative, fmtRub } from "@/lib/format";
import {
  Plus, Map as MapIcon, Users as UsersIcon, Wrench, BarChart3, QrCode,
  Bike as BikeIcon, AlertTriangle, CheckCircle2, Activity, ChevronRight,
} from "lucide-react";

// Active rides running longer than this are surfaced as an alert — a likely
// abandoned/forgotten rental or a lock that never reported its end.
const LONG_RIDE_HOURS = 4;

interface Alert {
  id: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  href: string;
}

export function AdminPage() {
  // Pull from existing endpoints. /api/admin/users is staff-protected; the rest
  // are public reads already used elsewhere in the operator UI. No new backend
  // surface is needed to assemble the dashboard.
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const usersQ = useQuery<User[]>({ queryKey: ["/api/admin/users"] });
  const ridesQ = useQuery<Ride[]>({ queryKey: ["/api/rides"] });
  const ticketsQ = useQuery<Ticket[]>({ queryKey: ["/api/tickets"] });
  const mapQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });

  const bikes = bikesQ.data ?? [];
  const users = usersQ.data ?? [];
  const rides = ridesQ.data ?? [];
  const tickets = ticketsQ.data ?? [];
  const mapObjects = mapQ.data ?? [];

  const m = useMemo(() => deriveMetrics({ bikes, users, rides, tickets, mapObjects }), [
    bikes, users, rides, tickets, mapObjects,
  ]);
  const alerts = useMemo(() => deriveAlerts(m), [m]);

  const loading = bikesQ.isLoading || ridesQ.isLoading || ticketsQ.isLoading;
  const critical = alerts.filter(a => a.severity === "critical").length;
  const serviceOk = alerts.length === 0;
  const userById = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="admin-dashboard">
      {/* ---------- Service status header ---------- */}
      <header
        className="mb-6 rounded-xl border border-card-border bg-card p-5 lg:p-6"
        data-testid="dashboard-status-header"
      >
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              Операторская панель · TakeRide
            </div>
            <div className="mt-2 flex items-center gap-3">
              {serviceOk ? (
                <span className="inline-flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="w-6 h-6" />
                  <span className="font-display text-2xl lg:text-3xl font-light">Сервис в норме</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-2 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-6 h-6" />
                  <span className="font-display text-2xl lg:text-3xl font-light">
                    Требуется внимание
                  </span>
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-sm mt-1" data-testid="dashboard-clock">
              {fmtNow()}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <StatusChip
              tone="sky"
              icon={<Activity className="w-3.5 h-3.5" />}
              label="Активные поездки"
              value={m.activeRides}
              testId="status-active-rides"
            />
            <StatusChip
              tone="emerald"
              icon={<BikeIcon className="w-3.5 h-3.5" />}
              label="Доступно"
              value={m.available}
              testId="status-available"
            />
            <StatusChip
              tone="rose"
              icon={<Wrench className="w-3.5 h-3.5" />}
              label="Сервис / оффлайн"
              value={m.maintenance + m.offline}
              testId="status-maintenance"
            />
            <StatusChip
              tone={critical > 0 ? "rose" : "muted"}
              icon={<AlertTriangle className="w-3.5 h-3.5" />}
              label="Критичные"
              value={critical}
              testId="status-critical"
            />
          </div>
        </div>
      </header>

      {/* ---------- KPI cards ---------- */}
      <section
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6"
        data-testid="dashboard-kpis"
      >
        <Kpi testId="dashboard-kpi-total-bikes" label="Всего велосипедов" value={m.totalBikes} icon={<BikeIcon className="w-4 h-4" />} />
        <Kpi testId="dashboard-kpi-available" label="Доступно" value={m.available} tone="emerald" />
        <Kpi testId="dashboard-kpi-rented" label="В аренде" value={m.rented} tone="sky" />
        <Kpi testId="dashboard-kpi-maintenance" label="Сервис / оффлайн" value={m.maintenance + m.offline} tone="rose" />
        <Kpi testId="dashboard-kpi-users" label="Пользователей" value={m.totalUsers} icon={<UsersIcon className="w-4 h-4" />} />
        <Kpi testId="dashboard-kpi-new-users" label="Новых сегодня" value={m.newUsersToday} />
        <Kpi testId="dashboard-kpi-rides-today" label="Поездок сегодня" value={m.ridesToday} />
        <Kpi testId="dashboard-kpi-active-rides" label="Активные поездки" value={m.activeRides} tone="sky" />
        <Kpi testId="dashboard-kpi-open-tickets" label="Открытых заявок" value={m.openTickets} tone={m.openTickets > 0 ? "amber" : undefined} icon={<Wrench className="w-4 h-4" />} />
        <Kpi testId="dashboard-kpi-map-objects" label="Объектов на карте" value={m.mapObjects} icon={<MapIcon className="w-4 h-4" />} />
      </section>

      {/* ---------- Quick actions ---------- */}
      <section className="mb-6" data-testid="dashboard-quick-actions">
        <h2 className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground mb-3">Быстрые действия</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <QuickAction href="/admin/bikes" icon={<Plus className="w-5 h-5" />} label="Добавить велосипед" testId="quick-action-add-bike" />
          <QuickAction href="/admin/map" icon={<MapIcon className="w-5 h-5" />} label="Редактор карты" testId="quick-action-map" />
          <QuickAction href="/admin/users" icon={<UsersIcon className="w-5 h-5" />} label="Пользователи" testId="quick-action-users" />
          <QuickAction href="/admin/maintenance" icon={<Wrench className="w-5 h-5" />} label="Сервис" testId="quick-action-maintenance" />
          <QuickAction href="/admin/analytics" icon={<BarChart3 className="w-5 h-5" />} label="Аналитика" testId="quick-action-analytics" />
          <QuickAction href="/admin/bikes" icon={<QrCode className="w-5 h-5" />} label="QR-коды" testId="quick-action-qr" />
        </div>
      </section>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* ---------- Alerts ---------- */}
        <Card className="p-5 lg:col-span-2" data-testid="dashboard-alerts">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-light flex items-center gap-2">
              <AlertTriangle className={`w-4 h-4 ${alerts.length ? "text-amber-500" : "text-muted-foreground"}`} />
              Требует внимания
            </h2>
            {alerts.length > 0 && <Badge variant="outline">{alerts.length}</Badge>}
          </div>
          {loading ? (
            <div className="text-sm text-muted-foreground py-6">Загружаем данные…</div>
          ) : alerts.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6" data-testid="dashboard-alerts-empty">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Активных проблем нет — флот работает штатно.
            </div>
          ) : (
            <div className="space-y-2">
              {alerts.map(a => (
                <Link
                  key={a.id}
                  href={a.href}
                  data-testid={`dashboard-alert-${a.id}`}
                  className="flex items-center gap-3 rounded-lg border border-card-border p-3 hover-elevate"
                >
                  <span
                    className={`flex items-center justify-center w-8 h-8 rounded-full shrink-0 ${
                      a.severity === "critical"
                        ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    }`}
                  >
                    <AlertTriangle className="w-4 h-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{a.title}</div>
                    <div className="text-xs text-muted-foreground truncate">{a.detail}</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </Card>

        {/* ---------- Fleet summary ---------- */}
        <Card className="p-5" data-testid="dashboard-fleet-summary">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-light flex items-center gap-2">
              <BikeIcon className="w-4 h-4 text-primary" />Флот
            </h2>
            <Link href="/admin/bikes" className="text-xs text-primary hover:underline" data-testid="link-fleet-detail">
              Управление
            </Link>
          </div>
          <div className="space-y-2 text-sm">
            <SummaryRow label="Доступно" value={m.available} tone="emerald" />
            <SummaryRow label="В аренде" value={m.rented} tone="sky" />
            <SummaryRow label="Бронь" value={m.reserved} />
            <SummaryRow label="Сервис" value={m.maintenance} tone="rose" />
            <SummaryRow label="Оффлайн" value={m.offline} />
            <SummaryRow label="Низкий заряд (<25%)" value={m.lowBattery} tone={m.lowBattery > 0 ? "amber" : undefined} />
          </div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        {/* ---------- Recent rides ---------- */}
        <Card className="p-5 lg:col-span-2" data-testid="dashboard-recent-rides">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-light flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />Последние поездки
            </h2>
            <Link href="/admin/analytics" className="text-xs text-primary hover:underline" data-testid="link-rides-detail">
              Аналитика
            </Link>
          </div>
          {loading ? (
            <div className="text-sm text-muted-foreground py-6">Загружаем данные…</div>
          ) : rides.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6">Поездок пока нет.</div>
          ) : (
            <div className="space-y-1.5">
              {rides.slice(0, 6).map(r => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 text-sm py-1.5 border-b border-card-border/50 last:border-0"
                  data-testid={`dashboard-ride-${r.id}`}
                >
                  <span className="font-mono text-xs w-16 shrink-0">{r.bikeId}</span>
                  <span className="flex-1 min-w-0 truncate text-muted-foreground">
                    {userById.get(r.userId)?.name ?? r.userId}
                  </span>
                  <RideStatusBadge status={r.status} />
                  <span className="w-20 text-right font-mono text-xs">{fmtRub(r.cost)}</span>
                  <span className="w-24 text-right text-xs text-muted-foreground hidden sm:block">
                    {fmtRelative(r.startedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ---------- Users & map summary ---------- */}
        <div className="space-y-4">
          <Card className="p-5" data-testid="dashboard-users-summary">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-lg font-light flex items-center gap-2">
                <UsersIcon className="w-4 h-4 text-primary" />Пользователи
              </h2>
              <Link href="/admin/users" className="text-xs text-primary hover:underline" data-testid="link-users-detail">
                Все
              </Link>
            </div>
            <div className="space-y-2 text-sm">
              <SummaryRow label="Всего" value={m.totalUsers} />
              <SummaryRow label="Новых сегодня" value={m.newUsersToday} tone={m.newUsersToday > 0 ? "emerald" : undefined} />
              <SummaryRow label="Операторов / админов" value={m.staffCount} />
              <SummaryRow label="Заблокировано" value={m.blockedUsers} tone={m.blockedUsers > 0 ? "rose" : undefined} />
            </div>
          </Card>

          <Card className="p-5" data-testid="dashboard-map-summary">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-lg font-light flex items-center gap-2">
                <MapIcon className="w-4 h-4 text-primary" />Карта
              </h2>
              <Link href="/admin/map" className="text-xs text-primary hover:underline" data-testid="link-map-detail">
                Редактор
              </Link>
            </div>
            {mapObjects.length === 0 ? (
              <div className="text-sm text-muted-foreground py-2" data-testid="dashboard-map-empty">
                Объекты не настроены. Добавьте маршруты и зоны в редакторе.
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <SummaryRow label="Всего объектов" value={m.mapObjects} />
                <SummaryRow label="Маршруты" value={m.mapRoutes} />
                <SummaryRow label="Зоны" value={m.mapZones} />
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- metrics & alerts ---------------- */

interface Metrics {
  totalBikes: number;
  available: number;
  rented: number;
  reserved: number;
  maintenance: number;
  offline: number;
  lowBattery: number;
  totalUsers: number;
  newUsersToday: number;
  staffCount: number;
  blockedUsers: number;
  activeRides: number;
  ridesToday: number;
  longActiveRides: { id: number; bikeId: string; hours: number }[];
  openTickets: number;
  highPriorityTickets: number;
  mapObjects: number;
  mapRoutes: number;
  mapZones: number;
}

function deriveMetrics(d: {
  bikes: Bike[]; users: User[]; rides: Ride[]; tickets: Ticket[]; mapObjects: MapObject[];
}): Metrics {
  const { bikes, users, rides, tickets, mapObjects } = d;
  const dayStart = startOfToday();

  const byStatus = (s: string) => bikes.filter(b => b.status === s).length;
  const activeRideRows = rides.filter(r => r.status === "active");

  return {
    totalBikes: bikes.length,
    available: byStatus("available"),
    rented: byStatus("rented"),
    reserved: byStatus("reserved"),
    maintenance: byStatus("maintenance"),
    offline: byStatus("offline"),
    lowBattery: bikes.filter(b => b.battery < 25 && b.status !== "archived").length,
    totalUsers: users.length,
    newUsersToday: users.filter(u => u.createdAt >= dayStart).length,
    staffCount: users.filter(u => u.role === "operator" || u.role === "admin").length,
    blockedUsers: users.filter(u => u.blockedAt).length,
    activeRides: activeRideRows.length,
    ridesToday: rides.filter(r => r.startedAt >= dayStart).length,
    longActiveRides: activeRideRows
      .map(r => ({ id: r.id, bikeId: r.bikeId, hours: (Date.now() - r.startedAt) / 3_600_000 }))
      .filter(r => r.hours >= LONG_RIDE_HOURS),
    openTickets: tickets.filter(t => t.status !== "resolved").length,
    highPriorityTickets: tickets.filter(t => t.status !== "resolved" && (t.kind === "repair_request" || t.kind === "out_of_zone")).length,
    mapObjects: mapObjects.length,
    mapRoutes: mapObjects.filter(o => o.kind === "route").length,
    mapZones: mapObjects.filter(o => o.kind === "zone").length,
  };
}

function deriveAlerts(m: Metrics): Alert[] {
  const out: Alert[] = [];

  if (m.totalBikes > 0 && m.available === 0) {
    out.push({
      id: "no-available",
      severity: "critical",
      title: "Нет доступных велосипедов",
      detail: "Ни один велосипед не доступен для аренды.",
      href: "/admin/bikes",
    });
  }
  if (m.maintenance + m.offline > 0) {
    out.push({
      id: "out-of-service",
      severity: "warning",
      title: `${m.maintenance + m.offline} вне ротации`,
      detail: `Сервис: ${m.maintenance}, оффлайн: ${m.offline}.`,
      href: "/admin/bikes",
    });
  }
  if (m.lowBattery > 0) {
    out.push({
      id: "low-battery",
      severity: "warning",
      title: `${m.lowBattery} с низким зарядом замка`,
      detail: "Заряд замка ниже 25% — требуется обслуживание.",
      href: "/admin/bikes",
    });
  }
  if (m.longActiveRides.length > 0) {
    const longest = m.longActiveRides.reduce((a, b) => (a.hours > b.hours ? a : b));
    out.push({
      id: "long-rides",
      severity: "critical",
      title: `${m.longActiveRides.length} затянувшихся поездок`,
      detail: `Поездка ${longest.bikeId} идёт ${longest.hours.toFixed(1)} ч (порог ${LONG_RIDE_HOURS} ч).`,
      href: "/admin/analytics",
    });
  }
  if (m.highPriorityTickets > 0) {
    out.push({
      id: "high-tickets",
      severity: "critical",
      title: `${m.highPriorityTickets} приоритетных заявок`,
      detail: "Ремонт или выезд из зоны — требуется реакция.",
      href: "/admin/maintenance",
    });
  } else if (m.openTickets > 0) {
    out.push({
      id: "open-tickets",
      severity: "warning",
      title: `${m.openTickets} открытых заявок`,
      detail: "Сервисные заявки ожидают обработки.",
      href: "/admin/maintenance",
    });
  }
  if (m.blockedUsers > 0) {
    out.push({
      id: "blocked-users",
      severity: "warning",
      title: `${m.blockedUsers} заблокированных аккаунтов`,
      detail: "Проверьте причины блокировки в разделе пользователей.",
      href: "/admin/users",
    });
  }
  if (m.totalBikes > 0 && m.mapObjects === 0) {
    out.push({
      id: "no-map",
      severity: "warning",
      title: "Карта не настроена",
      detail: "Не добавлено ни одного маршрута или зоны.",
      href: "/admin/map",
    });
  }

  return out;
}

/* ---------------- presentational helpers ---------------- */

const TONE_TEXT: Record<string, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  sky: "text-sky-600 dark:text-sky-400",
  rose: "text-rose-600 dark:text-rose-400",
  amber: "text-amber-600 dark:text-amber-400",
};

const CHIP_TONE: Record<string, string> = {
  emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  sky: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  rose: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  muted: "bg-muted text-muted-foreground",
};

function StatusChip({ tone, icon, label, value, testId }: {
  tone: string; icon: React.ReactNode; label: string; value: number; testId: string;
}) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 ${CHIP_TONE[tone] ?? CHIP_TONE.muted}`} data-testid={testId}>
      {icon}
      <div className="leading-tight">
        <div className="font-display text-lg font-light">{value}</div>
        <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      </div>
    </div>
  );
}

function Kpi({ label, value, testId, tone, icon }: {
  label: string; value: number; testId: string; tone?: string; icon?: React.ReactNode;
}) {
  return (
    <Card className="p-4" data-testid={testId}>
      <div className="flex items-center justify-between text-muted-foreground">
        <div className="text-[10px] uppercase tracking-widest">{label}</div>
        {icon}
      </div>
      <div className={`font-display text-2xl font-light mt-1 ${tone ? TONE_TEXT[tone] : ""}`}>{value}</div>
    </Card>
  );
}

function QuickAction({ href, icon, label, testId }: {
  href: string; icon: React.ReactNode; label: string; testId: string;
}) {
  return (
    <Link href={href} data-testid={testId}>
      <Card className="p-4 h-full flex flex-col items-center justify-center gap-2 text-center hover-elevate cursor-pointer">
        <span className="text-primary">{icon}</span>
        <span className="text-xs font-medium leading-tight">{label}</span>
      </Card>
    </Link>
  );
}

function SummaryRow({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono font-medium ${tone ? TONE_TEXT[tone] : ""}`}>{value}</span>
    </div>
  );
}

function RideStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "Активна", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" },
    completed: { label: "Завершена", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" },
    cancelled: { label: "Отменена", cls: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200" },
  };
  const s = map[status] ?? map.cancelled;
  return <Badge className={`${s.cls} border-0 hidden sm:inline-flex`}>{s.label}</Badge>;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtNow() {
  return new Date().toLocaleString("ru-RU", {
    weekday: "long", day: "2-digit", month: "long",
    hour: "2-digit", minute: "2-digit",
  });
}

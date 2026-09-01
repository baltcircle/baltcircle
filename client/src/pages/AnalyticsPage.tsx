import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from "@/components/ui/table";
import { fmtRub, fmtDuration, fmtDate, fmtRideTariff } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { apiRequest } from "@/lib/queryClient";
import type { AdminRide, User, Bike, Ticket } from "@shared/schema";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import {
  TrendingUp, Bike as BikeIcon, Wrench, MapPin, Users as UsersIcon,
  Download, AlertTriangle, Activity, Clock, Wallet, RefreshCw, Star,
} from "lucide-react";

/* ---------- Period filter ---------- */
type PeriodId = "today" | "7d" | "30d" | "all" | "custom";

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
// YYYY-MM-DD in local time for <input type="date"> values.
function toDateInput(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/* ---------- Service ticket labels (shared with maintenance) ---------- */
const KIND_LABEL: Record<string, string> = {
  wheel_puncture: "Колесо / прокол", brakes: "Тормоза", chain: "Цепь",
  handlebar_saddle: "Руль / седло", lock: "Замок", qr_sticker: "QR-наклейка",
  dirty: "Грязный велосипед", lost: "Потерян / не найден", other: "Другое",
  low_battery: "Низкий заряд замка", suspicious_idle: "Подозрительный простой",
  repair_request: "Заявка на ремонт", out_of_zone: "Вне зоны",
};
const PRIORITY_LABEL: Record<string, string> = {
  low: "Низкий", medium: "Средний", high: "Высокий", critical: "Критический",
};
const STATUS_LABEL: Record<string, string> = {
  new: "Новая", open: "Новая", in_progress: "В работе",
  waiting_parts: "Ждёт запчасти", resolved: "Решена",
  closed: "Закрыта", cancelled: "Отменена",
};

/* ---------- Analytics payload (mirrors storage.adminAnalytics) ---------- */
interface AdminAnalytics {
  range: { from: number; to: number };
  kpis: {
    ridesCount: number;
    activeRides: number;
    completedRides: number;
    revenue: number;
    avgDurationMin: number;
    avgCheck: number;
    newUsers: number;
    usersWithRides: number;
    openTickets: number;
  };
  byDay: { day: string; rides_count: number; revenue: number }[];
  topBikes: { id: string; model: string; status: string; rides: number }[];
  zeroRideBikes: { id: string; model: string; status: string; idleHours: number }[];
  usersSummary: { total: number; newInPeriod: number; withRidesInPeriod: number; blocked: number };
  service: {
    byPriority: { priority: string; c: number }[];
    byStatus: { status: string; c: number }[];
    byKind: { kind: string; c: number }[];
    repeatedProblemBikes: { bike_id: string; tickets: number; open: number }[];
  };
  parkingUsage: { id: string; name: string; capacity: number; occupied: number; rideStarts: number }[];
  feedbackCounts: { low: number; mid: number; high: number };
}

export function AnalyticsPage() {
  const [period, setPeriod] = useState<PeriodId>("30d");
  const now = Date.now();
  const [customFrom, setCustomFrom] = useState(() => toDateInput(now - 7 * DAY));
  const [customTo, setCustomTo] = useState(() => toDateInput(now));

  const range = useMemo(() => {
    if (period === "today") return { from: startOfDay(now), to: endOfDay(now) };
    if (period === "7d") return { from: startOfDay(now - 6 * DAY), to: endOfDay(now) };
    if (period === "30d") return { from: startOfDay(now - 29 * DAY), to: endOfDay(now) };
    if (period === "all") return { from: 0, to: endOfDay(now) };
    // custom
    const from = startOfDay(new Date(customFrom + "T00:00:00").getTime());
    const to = endOfDay(new Date(customTo + "T00:00:00").getTime());
    return { from, to };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, customFrom, customTo]);

  const validCustom = range.from <= range.to;

  const q = useQuery<AdminAnalytics>({
    queryKey: ["/api/admin/analytics", range.from, range.to],
    enabled: validCustom,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/admin/analytics?from=${range.from}&to=${range.to}`,
      );
      return res.json();
    },
  });

  const a = q.data;

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-analytics">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Операционный центр</div>
        <div className="flex flex-wrap items-center gap-3 mt-1">
          <h1 className="font-display text-2xl lg:text-3xl font-light">Аналитика</h1>
        </div>
      </header>

      {/* ---------- Controls: period + export ---------- */}
      <div className="flex flex-col lg:flex-row lg:items-end gap-4 mb-6">
        <div className="flex-1">
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground mb-2">Период</div>
          <div className="flex flex-wrap gap-2">
            <PeriodButton active={period === "today"} onClick={() => setPeriod("today")} testId="analytics-period-today">Сегодня</PeriodButton>
            <PeriodButton active={period === "7d"} onClick={() => setPeriod("7d")} testId="analytics-period-7d">7 дней</PeriodButton>
            <PeriodButton active={period === "30d"} onClick={() => setPeriod("30d")} testId="analytics-period-30d">30 дней</PeriodButton>
            <PeriodButton active={period === "all"} onClick={() => setPeriod("all")} testId="analytics-period-all">За все время</PeriodButton>
            <PeriodButton active={period === "custom"} onClick={() => setPeriod("custom")} testId="analytics-period-custom">Период</PeriodButton>
          </div>
          {period === "custom" && (
            <div className="flex flex-wrap items-center gap-2 mt-3" data-testid="analytics-custom-range">
              <label className="text-xs text-muted-foreground">с</label>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                data-testid="analytics-custom-from"
              />
              <label className="text-xs text-muted-foreground">по</label>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                data-testid="analytics-custom-to"
              />
              {!validCustom && (
                <span className="text-xs text-destructive">Дата начала позже даты конца</span>
              )}
            </div>
          )}
        </div>

        <ExportBar />
      </div>

      {/* ---------- Loading / error / content ---------- */}
      {!validCustom ? (
        <Card className="p-10 text-muted-foreground" data-testid="analytics-range-invalid">
          Укажите корректный диапазон дат.
        </Card>
      ) : q.isError ? (
        <Card className="p-10" data-testid="analytics-error">
          <div className="flex items-center gap-2 text-destructive mb-3">
            <AlertTriangle className="w-4 h-4" />
            Не удалось загрузить аналитику.
          </div>
          <Button variant="outline" size="sm" onClick={() => q.refetch()} data-testid="analytics-retry">
            <RefreshCw className="w-4 h-4 mr-1" /> Повторить
          </Button>
        </Card>
      ) : !a ? (
        <Card className="p-10 text-muted-foreground" data-testid="analytics-loading">Загружаем данные…</Card>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mb-6" data-testid="analytics-kpis">
            <Kpi label="Поездок за период" value={String(a.kpis.ridesCount)} icon={<Activity className="w-4 h-4" />} testId="analytics-kpi-rides" />
            <Kpi label="Активных поездок" value={String(a.kpis.activeRides)} icon={<BikeIcon className="w-4 h-4" />} testId="analytics-kpi-active-rides" />
            <Kpi label="Выручка (по тарифам)" value={fmtRub(a.kpis.revenue)} icon={<Wallet className="w-4 h-4" />} testId="analytics-kpi-revenue" />
            <Kpi label="Ср. длительность" value={fmtDuration(a.kpis.avgDurationMin * 60000)} icon={<Clock className="w-4 h-4" />} testId="analytics-kpi-avg-duration" />
            <Kpi label="Средний чек" value={fmtRub(a.kpis.avgCheck)} icon={<Wallet className="w-4 h-4" />} testId="analytics-kpi-avg-check" />
            <Kpi label="Новых пользователей" value={String(a.kpis.newUsers)} icon={<UsersIcon className="w-4 h-4" />} testId="analytics-kpi-new-users" />
            <Kpi label="С поездками за период" value={String(a.kpis.usersWithRides)} icon={<UsersIcon className="w-4 h-4" />} testId="analytics-kpi-users-with-rides" />
            <Kpi label="Открытых заявок" value={String(a.kpis.openTickets)} icon={<Wrench className="w-4 h-4" />} testId="analytics-kpi-open-tickets" />
          </div>

          {/* Rides per day trend */}
          <Card className="p-5 mb-6" data-testid="analytics-chart-rides">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-lg font-light flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" />Поездки по дням
              </h2>
              <Badge variant="outline">{a.byDay.length} дн.</Badge>
            </div>
            {a.byDay.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8" data-testid="analytics-chart-empty">
                Нет поездок за выбранный период.
              </div>
            ) : (
              <div className="h-60">
                <ResponsiveContainer>
                  <AreaChart data={a.byDay} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="ridesArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.55} />
                        <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="day" tickFormatter={(d) => String(d).slice(5)} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                    <YAxis fontSize={11} stroke="hsl(var(--muted-foreground))" allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Area type="monotone" dataKey="rides_count" name="Поездки" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#ridesArea)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* Feedback counts by rating tier */}
          <Card className="p-5 mb-6" data-testid="analytics-feedback">
            <h2 className="font-display text-lg font-light flex items-center gap-2 mb-3">
              <Star className="w-4 h-4 text-primary" />Отзывы о поездках
            </h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Оценка</TableHead>
                  <TableHead className="text-right">Количество отзывов</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow data-testid="analytics-feedback-low">
                  <TableCell>1-3 звезды</TableCell>
                  <TableCell className="text-right font-mono">{a.feedbackCounts.low}</TableCell>
                </TableRow>
                <TableRow data-testid="analytics-feedback-mid">
                  <TableCell>4 звезды</TableCell>
                  <TableCell className="text-right font-mono">{a.feedbackCounts.mid}</TableCell>
                </TableRow>
                <TableRow data-testid="analytics-feedback-high">
                  <TableCell>5 звёзд</TableCell>
                  <TableCell className="text-right font-mono">{a.feedbackCounts.high}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Card>

          {/* Repeated-problem bikes */}
          <Card className="p-5 mb-6" data-testid="analytics-repeated-bikes">
            <h2 className="font-display text-lg font-light flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-destructive" />Повторяющиеся проблемы
            </h2>
            {a.service.repeatedProblemBikes.length === 0 ? (
              <EmptyRow text="Нет велосипедов с несколькими заявками." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Велосипед</TableHead>
                    <TableHead className="text-right">Заявок всего</TableHead>
                    <TableHead className="text-right">Открытых</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {a.service.repeatedProblemBikes.map((b) => (
                    <TableRow key={b.bike_id} data-testid={`analytics-repeated-bike-${b.bike_id}`}>
                      <TableCell className="font-mono">{b.bike_id}</TableCell>
                      <TableCell className="text-right font-mono">{b.tickets}</TableCell>
                      <TableCell className="text-right font-mono">{b.open}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          {/* Parking usage */}
          <Card className="p-5" data-testid="analytics-parking">
            <h2 className="font-display text-lg font-light flex items-center gap-2 mb-3">
              <MapPin className="w-4 h-4 text-primary" />Парковки
            </h2>
            {a.parkingUsage.length === 0 ? (
              <EmptyRow text="Парковки не настроены — данных нет." />
            ) : a.parkingUsage.every((p) => p.rideStarts === 0) ? (
              <div className="text-sm text-muted-foreground py-4" data-testid="analytics-parking-empty">
                За выбранный период стартов рядом с парковками не зафиксировано.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Парковка</TableHead>
                    <TableHead className="text-right">Стартов рядом</TableHead>
                    <TableHead className="text-right">Занято / вместимость</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {a.parkingUsage.slice(0, 15).map((p) => (
                    <TableRow key={p.id} data-testid={`analytics-parking-${p.id}`}>
                      <TableCell>{p.name}</TableCell>
                      <TableCell className="text-right font-mono">{p.rideStarts}</TableCell>
                      <TableCell className="text-right font-mono">{p.occupied} / {p.capacity}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/* ---------- Export bar (client-side CSV from existing admin endpoints) ---------- */
function ExportBar() {
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch {
      // surface nothing fancy; the button just re-enables
    } finally {
      setBusy(null);
    }
  };

  const exportRides = () =>
    run("rides", async () => {
      // The rides endpoint clamps `limit` to 200 (audit M5), so page through
      // with offset until a short page signals the end rather than asking for an
      // unbounded slice.
      const pageSize = 200;
      const rows: AdminRide[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = (await (await apiRequest(
          "GET",
          `/api/admin/rides?limit=${pageSize}&offset=${offset}`,
        )).json()) as AdminRide[];
        rows.push(...page);
        if (page.length < pageSize) break;
      }
      downloadCsv("rides.csv", rows, [
        { header: "ID", value: (r) => r.id },
        { header: "Велосипед", value: (r) => r.bikeId },
        { header: "Пользователь", value: (r) => r.userName ?? r.userId },
        { header: "Телефон", value: (r) => r.userPhone ?? "" },
        { header: "Начало", value: (r) => fmtDate(r.startedAt) },
        { header: "Конец", value: (r) => (r.endedAt ? fmtDate(r.endedAt) : "") },
        { header: "Дистанция, м", value: (r) => Math.round(r.distanceM) },
        { header: "Стоимость, ₽", value: (r) => Math.round(r.cost) / 100 },
        { header: "Тариф", value: (r) => fmtRideTariff(r) },
        { header: "Статус", value: (r) => r.status },
      ]);
    });

  const exportUsers = () =>
    run("users", async () => {
      const rows = (await (await apiRequest("GET", "/api/admin/users")).json()) as User[];
      downloadCsv("users.csv", rows, [
        { header: "ID", value: (u) => u.id },
        { header: "Имя", value: (u) => u.name },
        { header: "Телефон", value: (u) => u.phone },
        { header: "Email", value: (u) => u.email ?? "" },
        { header: "Роль", value: (u) => u.role },
        { header: "Регистрация", value: (u) => fmtDate(u.createdAt) },
        { header: "Заблокирован", value: (u) => (u.blockedAt ? "да" : "нет") },
      ]);
    });

  const exportBikes = () =>
    run("bikes", async () => {
      const rows = (await (await apiRequest("GET", "/api/admin/bikes")).json()) as Bike[];
      downloadCsv("bikes.csv", rows, [
        { header: "ID", value: (b) => b.id },
        { header: "Модель", value: (b) => b.model },
        { header: "Статус", value: (b) => b.status },
        { header: "Заряд замка, %", value: (b) => b.battery },
        { header: "Простой, ч", value: (b) => b.idleHours.toFixed(1) },
        { header: "Парковка", value: (b) => b.parkingId ?? "" },
      ]);
    });

  const exportTickets = () =>
    run("tickets", async () => {
      const rows = (await (await apiRequest("GET", "/api/tickets")).json()) as Ticket[];
      downloadCsv("tickets.csv", rows, [
        { header: "ID", value: (t) => t.id },
        { header: "Велосипед", value: (t) => t.bikeId },
        { header: "Тип", value: (t) => KIND_LABEL[t.kind] ?? t.kind },
        { header: "Приоритет", value: (t) => PRIORITY_LABEL[t.priority] ?? t.priority },
        { header: "Статус", value: (t) => STATUS_LABEL[t.status] ?? t.status },
        { header: "Заголовок", value: (t) => t.title },
        { header: "Создана", value: (t) => fmtDate(t.createdAt) },
        { header: "Исполнитель", value: (t) => t.assignee ?? "" },
      ]);
    });

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground mb-2">Экспорт CSV</div>
      <div className="flex flex-wrap gap-2">
        <ExportButton onClick={exportRides} busy={busy === "rides"} testId="analytics-export-rides">Поездки</ExportButton>
        <ExportButton onClick={exportUsers} busy={busy === "users"} testId="analytics-export-users">Пользователи</ExportButton>
        <ExportButton onClick={exportBikes} busy={busy === "bikes"} testId="analytics-export-bikes">Велосипеды</ExportButton>
        <ExportButton onClick={exportTickets} busy={busy === "tickets"} testId="analytics-export-tickets">Заявки</ExportButton>
      </div>
    </div>
  );
}

/* ---------- Small presentational helpers ---------- */
function PeriodButton({ active, onClick, children, testId }: {
  active: boolean; onClick: () => void; children: React.ReactNode; testId: string;
}) {
  return (
    <Button variant={active ? "default" : "outline"} size="sm" onClick={onClick} data-testid={testId}>
      {children}
    </Button>
  );
}

function ExportButton({ onClick, busy, children, testId }: {
  onClick: () => void; busy: boolean; children: React.ReactNode; testId: string;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={busy} data-testid={testId}>
      <Download className="w-4 h-4 mr-1" />
      {busy ? "Готовим…" : children}
    </Button>
  );
}

function Kpi({ label, value, testId, icon }: { label: string; value: string; testId: string; icon?: React.ReactNode }) {
  return (
    <Card className="p-4" data-testid={testId}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        {icon}{label}
      </div>
      <div className="font-display text-xl lg:text-2xl font-light mt-1">{value}</div>
    </Card>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="text-sm text-muted-foreground py-4">{text}</div>;
}

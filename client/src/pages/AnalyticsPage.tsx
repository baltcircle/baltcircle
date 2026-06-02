import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtDistance, fmtDuration, fmtRub, fmtRelative } from "@/lib/format";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
} from "recharts";
import { TrendingUp, Bike, Wrench, MapPin, AlertTriangle } from "lucide-react";

interface Analytics {
  total: number;
  completed: number;
  revenue: number;
  avgDuration: number;  // minutes
  avgDistance: number;  // metres
  idleAvg: number;
  byDay: { day: string; rides_count: number; revenue: number }[];
  parkingCounts: { id: string; name: string; rideStarts: number; capacity: number }[];
  utilisation: { bike_id: string; rides: number }[];
  problemBikes: any[];
}

export function AnalyticsPage() {
  const q = useQuery<Analytics>({ queryKey: ["/api/analytics"] });
  const a = q.data;

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-analytics">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Операционный центр</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Аналитика парка</h1>
      </header>

      {!a ? (
        <Card className="p-10 text-muted-foreground">Загружаем данные…</Card>
      ) : (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
            <Kpi label="Поездок (мес.)" value={a.total.toString()} testId="kpi-total" />
            <Kpi label="Выручка" value={fmtRub(a.revenue)} testId="kpi-revenue" />
            <Kpi label="Ср. длительность" value={fmtDuration(a.avgDuration * 60000)} testId="kpi-avg-duration" />
            <Kpi label="Ср. расстояние" value={fmtDistance(a.avgDistance)} testId="kpi-avg-distance" />
            <Kpi label="Ср. простой" value={(a.idleAvg ?? 0).toFixed(1) + " ч"} testId="kpi-idle" />
          </div>

          <div className="grid lg:grid-cols-3 gap-4 mb-6">
            {/* Rides per day */}
            <Card className="p-5 lg:col-span-2" data-testid="chart-rides-per-day">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display text-lg font-light flex items-center gap-2"><TrendingUp className="w-4 h-4 text-primary" />Поездки по дням</h2>
                <Badge variant="outline">14 дней</Badge>
              </div>
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
                    <XAxis dataKey="day" tickFormatter={d => d.slice(5)} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                    <YAxis fontSize={11} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Area type="monotone" dataKey="rides_count" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#ridesArea)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>

            {/* Revenue */}
            <Card className="p-5" data-testid="chart-revenue">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-display text-lg font-light">Выручка</h2>
                <Badge variant="outline">₽</Badge>
              </div>
              <div className="h-60">
                <ResponsiveContainer>
                  <LineChart data={a.byDay} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="day" tickFormatter={d => d.slice(5)} fontSize={11} stroke="hsl(var(--muted-foreground))" />
                    <YAxis fontSize={11} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Line type="monotone" dataKey="revenue" stroke="hsl(var(--chart-2))" strokeWidth={2.4} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid lg:grid-cols-3 gap-4 mb-6">
            {/* Popular parkings */}
            <Card className="p-5 lg:col-span-2" data-testid="chart-popular-parkings">
              <h2 className="font-display text-lg font-light flex items-center gap-2 mb-3"><MapPin className="w-4 h-4 text-primary" />Популярные парковки</h2>
              <div className="h-72">
                <ResponsiveContainer>
                  <BarChart
                    data={a.parkingCounts.slice(0, 10)}
                    layout="vertical"
                    margin={{ top: 8, right: 16, left: 100, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <XAxis type="number" fontSize={11} stroke="hsl(var(--muted-foreground))" />
                    <YAxis dataKey="name" type="category" fontSize={11} width={140} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                    <Bar dataKey="rideStarts" fill="hsl(var(--chart-1))" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            {/* Top utilisation bikes */}
            <Card className="p-5" data-testid="chart-utilisation">
              <h2 className="font-display text-lg font-light flex items-center gap-2 mb-3"><Bike className="w-4 h-4 text-primary" />Топ по аренде</h2>
              <div className="space-y-2">
                {a.utilisation.map((u, i) => (
                  <div key={u.bike_id} className="flex items-center gap-3 text-sm" data-testid={`util-row-${u.bike_id}`}>
                    <span className="font-mono w-16 text-muted-foreground">{u.bike_id}</span>
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-primary" style={{ width: `${Math.min(100, u.rides * 8)}%` }} />
                    </div>
                    <span className="font-mono w-8 text-right">{u.rides}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Problem bikes */}
          <Card className="p-5" data-testid="card-problem-bikes">
            <h2 className="font-display text-lg font-light flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              Проблемные велосипеды
            </h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
              {a.problemBikes.map(b => (
                <Card key={b.id} className="p-3 border-destructive/20" data-testid={`problem-${b.id}`}>
                  <div className="flex items-center justify-between">
                    <div className="font-mono">{b.id}</div>
                    <Badge variant="outline" className="text-destructive border-destructive/40">{b.battery < 25 ? "Низкий заряд" : "Простой"}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                    <Mini label="Замок" value={`${b.battery}%`} />
                    <Mini label="Простой" value={`${b.idle_hours.toFixed(1)}ч`} />
                    <Mini label="Сигнал" value={fmtRelative(b.last_seen)} />
                  </div>
                </Card>
              ))}
              {a.problemBikes.length === 0 && (
                <div className="text-sm text-muted-foreground p-4">Проблемных нет — отличная работа!</div>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Card className="p-4" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="font-display text-xl lg:text-2xl font-light mt-1">{value}</div>
    </Card>
  );
}
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="font-display font-light">{value}</div>
    </div>
  );
}

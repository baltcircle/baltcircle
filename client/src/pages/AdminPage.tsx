import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "wouter";
import type { Bike, User, Ride, Ticket, MapObject, Parking, SupportTicketWithUser, Alert } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtRelative, fmtRub } from "@/lib/format";
import {
  Map as MapIcon, Users as UsersIcon, Wrench,
  Bike as BikeIcon, AlertTriangle, CheckCircle2, Activity, ChevronRight,
  LifeBuoy, MessageSquare, AlertOctagon, ShieldAlert,
} from "lucide-react";
import { useSupportUnread } from "@/hooks/use-support-unread";
import { useFleetStream } from "@/hooks/use-fleet-stream";
import { OperationsMapPage } from "./OperationsMapPage";
import { deriveMetrics, deriveAlerts, fmtNow } from "./admin/metrics";
import { StatusChip, SummaryRow, RideStatusBadge } from "./admin/dashboard-widgets";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export function AdminPage() {
  // Pull from existing endpoints. /api/admin/users is staff-protected; the rest
  // are public reads already used elsewhere in the operator UI. No new backend
  // surface is needed to assemble the dashboard.
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  useFleetStream(); // живое обновление счётчиков статусов
  const usersQ = useQuery<User[]>({ queryKey: ["/api/admin/users"] });
  const ridesQ = useQuery<Ride[]>({ queryKey: ["/api/rides"] });
  const ticketsQ = useQuery<Ticket[]>({ queryKey: ["/api/tickets"] });
  const mapQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });
  // Public endpoint returns active, non-archived parkings only — exactly the
  // count riders can see on the map.
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  // Rider help requests submitted from the /support page. Separate from
  // mechanic tickets (/api/tickets) which describe bike issues.
  const supportQ = useQuery<SupportTicketWithUser[]>({ queryKey: ["/api/admin/support/tickets"] });
  // Fleet alerts from OMNI lock alarms (fall = code 2, movement_alarm = code 1).
  // Manual ack, persists until acknowledged — separate concept from computed
  // deriveAlerts(). Single endpoint returns all kinds; split by `kind` below.
  const fleetAlertsQ = useQuery<Alert[]>({ queryKey: ["/api/admin/alerts"] });

  const bikes = bikesQ.data ?? [];
  const users = usersQ.data ?? [];
  const rides = ridesQ.data ?? [];
  const tickets = ticketsQ.data ?? [];
  const mapObjects = mapQ.data ?? [];
  const parkings = parkingsQ.data ?? [];
  const supportTickets = supportQ.data ?? [];
  const openSupport = supportTickets.filter(t => t.status !== "resolved");

  // Непрочитанные чаты + звуковое уведомление при новом сообщении от пользователя.
  const support = useSupportUnread();

  const toast = useToast();
  const ackAlertMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/alerts/${id}/ack`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/alerts"] });
      toast.toast({ title: "Алерт подтверждён" });
    },
    onError: (e: any) => toast.toast({ title: "Не удалось подтвердить алерт", description: String(e?.message ?? e), variant: "destructive" }),
  });
  const fallAlerts = (fleetAlertsQ.data ?? []).filter((a) => a.kind === "fall");
  const movementAlerts = (fleetAlertsQ.data ?? []).filter((a) => a.kind === "movement_alarm");

  const m = useMemo(() => deriveMetrics({ bikes, users, rides, tickets, mapObjects, parkings }), [
    bikes, users, rides, tickets, mapObjects, parkings,
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
              tone="emerald"
              icon={<CheckCircle2 className="w-3.5 h-3.5" />}
              label="Доступно"
              value={m.available}
              testId="status-available"
            />
            <StatusChip
              tone="sky"
              icon={<BikeIcon className="w-3.5 h-3.5" />}
              label="В аренде"
              value={m.rented}
              testId="status-rented"
            />
            <StatusChip
              tone="muted"
              icon={<Activity className="w-3.5 h-3.5" />}
              label="Поездок сегодня"
              value={m.ridesToday}
              testId="status-rides-today"
            />
            <StatusChip
              tone={m.openTickets > 0 ? "amber" : "muted"}
              icon={<Wrench className="w-3.5 h-3.5" />}
              label="Сервисные заявки"
              value={m.openTickets}
              testId="status-open-tickets"
            />
            <StatusChip
              tone={openSupport.length > 0 ? "amber" : "muted"}
              icon={<LifeBuoy className="w-3.5 h-3.5" />}
              label="Обращения в поддержку"
              value={openSupport.length}
              testId="status-open-support"
            />
          </div>
        </div>
      </header>

      {/* ---------- Operator map (embedded from OperationsMapPage) ---------- */}
      <section className="mb-6" data-testid="dashboard-operations-map">
        <OperationsMapPage embedded />
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

        {/* ---------- Support inbox summary ---------- */}
        <Card className="p-5" data-testid="dashboard-support-inbox">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-light flex items-center gap-2">
              <LifeBuoy className={`w-4 h-4 ${(openSupport.length || support.unreadTotal) ? "text-amber-500" : "text-primary"}`} />
              Поддержка
            </h2>
            <div className="flex items-center gap-2">
              {support.unreadTotal > 0 && (
                <Badge className="bg-red-500 text-white hover:bg-red-500" data-testid="dashboard-support-unread-badge">
                  <MessageSquare className="w-3 h-3 mr-1" />
                  {support.unreadTotal > 99 ? "99+" : support.unreadTotal} новых
                </Badge>
              )}
              <Link href="/admin/support" className="text-xs text-primary hover:underline" data-testid="link-support-detail">
                Чаты
              </Link>
            </div>
          </div>
          {supportQ.isLoading ? (
            <div className="text-sm text-muted-foreground py-4" data-testid="dashboard-support-loading">Загружаем…</div>
          ) : openSupport.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4" data-testid="dashboard-support-empty">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Открытых обращений нет.
            </div>
          ) : (
            <div className="space-y-2">
              {openSupport.slice(0, 4).map(t => (
                <Link
                  key={t.id}
                  href="/admin/support"
                  className="block rounded-lg border border-card-border p-2.5 hover-elevate"
                  data-testid={`dashboard-support-${t.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium truncate">{t.subject}</div>
                    <span className="text-[10px] text-muted-foreground shrink-0">{fmtRelative(t.createdAt)}</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {t.userName ?? t.userPhone ?? t.userId}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ---------- Fall-alarm alerts (OMNI lock alarm code 2, manual ack) ---------- */}
      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <Card className="p-5 lg:col-span-3" data-testid="dashboard-fall-alerts">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-light flex items-center gap-2">
              <AlertOctagon className={`w-4 h-4 ${fallAlerts.length ? "text-rose-500" : "text-muted-foreground"}`} />
              Упавшие велосипеды
            </h2>
            {fallAlerts.length > 0 && <Badge variant="destructive">{fallAlerts.length}</Badge>}
          </div>
          {fleetAlertsQ.isLoading ? (
            <div className="text-sm text-muted-foreground py-4">Загружаем данные…</div>
          ) : fallAlerts.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4" data-testid="dashboard-fall-alerts-empty">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Сигналов падения нет.
            </div>
          ) : (
            <div className="space-y-2">
              {fallAlerts.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-3 rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 p-3"
                  data-testid={`dashboard-fall-alert-${a.id}`}
                >
                  <span className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                    <AlertOctagon className="w-4 h-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link href="/admin/bikes" className="text-sm font-medium hover:underline">
                      {a.bikeId}
                    </Link>
                    <div className="text-xs text-muted-foreground truncate">
                      Упал {fmtRelative(a.createdAt)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={ackAlertMut.isPending}
                    onClick={() => ackAlertMut.mutate(a.id)}
                    data-testid={`ack-fall-alert-${a.id}`}
                  >
                    Подтвердить
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ---------- Movement-alarm alerts (OMNI lock alarm code 1, manual ack) ---------- */}
      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <Card className="p-5 lg:col-span-3" data-testid="dashboard-movement-alerts">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-light flex items-center gap-2">
              <ShieldAlert className={`w-4 h-4 ${movementAlerts.length ? "text-amber-500" : "text-muted-foreground"}`} />
              Несанкционированное перемещение
            </h2>
            {movementAlerts.length > 0 && <Badge variant="destructive">{movementAlerts.length}</Badge>}
          </div>
          {fleetAlertsQ.isLoading ? (
            <div className="text-sm text-muted-foreground py-4">Загружаем данные…</div>
          ) : movementAlerts.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4" data-testid="dashboard-movement-alerts-empty">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              Сигналов несанкционированного перемещения нет.
            </div>
          ) : (
            <div className="space-y-2">
              {movementAlerts.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-3 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 p-3"
                  data-testid={`dashboard-movement-alert-${a.id}`}
                >
                  <span className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    <ShieldAlert className="w-4 h-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link href="/admin/bikes" className="text-sm font-medium hover:underline">
                      {a.bikeId}
                    </Link>
                    <div className="text-xs text-muted-foreground truncate">
                      Несанкционированное движение {fmtRelative(a.createdAt)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={ackAlertMut.isPending}
                    onClick={() => ackAlertMut.mutate(a.id)}
                    data-testid={`ack-movement-alert-${a.id}`}
                  >
                    Подтвердить
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        {/* ---------- Recent rides ---------- */}
        <Card className="p-5 lg:col-span-2" data-testid="dashboard-recent-rides">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-lg font-light flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" />Последние поездки
            </h2>
            <Link href="/admin/rides" className="text-xs text-primary hover:underline" data-testid="link-rides-detail">
              Все поездки
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

        {/* ---------- Fleet + Users & map summary ---------- */}
        <div className="space-y-4">
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

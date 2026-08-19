import type { Bike, User, Ride, Ticket, MapObject, Parking } from "@shared/schema";
import { TICKET_CLOSED_STATUSES } from "@shared/schema";

// Active rides running longer than this are surfaced as an alert — a likely
// abandoned/forgotten rental or a lock that never reported its end.
const LONG_RIDE_HOURS = 4;

export interface Alert {
  id: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  href: string;
}

/* ---------------- metrics & alerts ---------------- */

export interface Metrics {
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
  activeParkings: number;
}

export function deriveMetrics(d: {
  bikes: Bike[]; users: User[]; rides: Ride[]; tickets: Ticket[]; mapObjects: MapObject[]; parkings: Parking[];
}): Metrics {
  const { bikes, users, rides, tickets, mapObjects, parkings } = d;
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
    openTickets: tickets.filter(t => !TICKET_CLOSED_STATUSES.includes(t.status)).length,
    highPriorityTickets: tickets.filter(t => !TICKET_CLOSED_STATUSES.includes(t.status) && (t.priority === "high" || t.priority === "critical")).length,
    mapObjects: mapObjects.length,
    mapRoutes: mapObjects.filter(o => o.kind === "route").length,
    mapZones: mapObjects.filter(o => o.kind === "zone").length,
    activeParkings: parkings.length,
  };
}

export function deriveAlerts(m: Metrics): Alert[] {
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
      href: "/admin/rides",
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
  if (m.activeParkings === 0) {
    out.push({
      id: "no-parkings",
      severity: "warning",
      title: "Нет активных парковок",
      detail: "Клиенты не увидят точек на карте — добавьте или активируйте парковку.",
      href: "/admin/parkings",
    });
  }

  return out;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function fmtNow() {
  return new Date().toLocaleString("ru-RU", {
    weekday: "long", day: "2-digit", month: "long",
    hour: "2-digit", minute: "2-digit",
  });
}

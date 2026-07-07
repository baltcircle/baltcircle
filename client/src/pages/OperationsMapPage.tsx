import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { Bike, Parking, AdminRide, Ticket, MapObject } from "@shared/schema";
import { TICKET_CLOSED_STATUSES } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapLibreMap, type MapLayers } from "@/components/MapLibreMap";
import { fmtDate, fmtRub } from "@/lib/format";
import {
  Bike as BikeIcon, MapPin, Route, Wrench, RefreshCw, X,
  ParkingCircle, Activity, ExternalLink,
} from "lucide-react";

// Status strings that mean a bike is part of the live operational fleet (i.e.
// not soft-deleted). Archived bikes must never reach the operations map.
const VISIBLE_BIKE = (b: Bike) => b.status !== "archived";

const BIKE_STATUS_LABEL: Record<string, string> = {
  available: "Доступен",
  rented: "В аренде",
  reserved: "Забронирован",
  maintenance: "Сервис",
  offline: "Оффлайн",
  storage: "Склад",
  lost: "Потерян",
  archived: "Архив",
};

const TICKET_PRIORITY_LABEL: Record<string, string> = {
  low: "низкий",
  medium: "средний",
  high: "высокий",
  critical: "критический",
};

type LayerKey = keyof MapLayers;

const LAYER_DEFS: { key: LayerKey; label: string; testId: string; icon: typeof BikeIcon }[] = [
  { key: "parkings", label: "Парковки",   testId: "toggle-layer-parkings", icon: ParkingCircle },
  { key: "bikes",    label: "Велосипеды", testId: "toggle-layer-bikes",    icon: BikeIcon },
  { key: "rides",    label: "Поездки",    testId: "toggle-layer-rides",    icon: Route },
  { key: "tickets",  label: "Тикеты",     testId: "toggle-layer-tickets",  icon: Wrench },
  { key: "objects",  label: "Зоны / маршруты", testId: "toggle-layer-zones", icon: MapPin },
];

type Selection =
  | { kind: "bike"; id: string }
  | { kind: "parking"; id: string }
  | { kind: "ride"; id: number }
  | { kind: "ticket"; id: number }
  | null;

export function OperationsMapPage() {
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/admin/bikes"] });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/admin/parkings"] });
  const ridesQ = useQuery<AdminRide[]>({ queryKey: ["/api/admin/rides"] });
  const ticketsQ = useQuery<Ticket[]>({ queryKey: ["/api/tickets"] });
  const objectsQ = useQuery<MapObject[]>({ queryKey: ["/api/admin/map-objects"] });

  const [layers, setLayers] = useState<MapLayers>({
    parkings: true, bikes: true, rides: true, tickets: true, objects: true,
  });
  const [selection, setSelection] = useState<Selection>(null);

  // Live fleet: every non-archived bike (archived bikes are hidden everywhere).
  const bikes = useMemo(
    () => (bikesQ.data ?? []).filter(VISIBLE_BIKE),
    [bikesQ.data],
  );
  // Archived parkings must never render; inactive ones render muted via the map.
  const parkings = useMemo(
    () => (parkingsQ.data ?? []).filter((p) => !p.archivedAt),
    [parkingsQ.data],
  );
  const activeRides = useMemo(
    () => (ridesQ.data ?? []).filter((r) => r.status === "active"),
    [ridesQ.data],
  );
  // Open tickets = not in a closed/resolved/cancelled state. Highlight the
  // high-priority ones, but keep all open tickets available on the map.
  const openTickets = useMemo(
    () => (ticketsQ.data ?? []).filter((t) => !TICKET_CLOSED_STATUSES.includes(t.status)),
    [ticketsQ.data],
  );
  const activeObjects = useMemo(
    () => (objectsQ.data ?? []).filter((o) => o.active),
    [objectsQ.data],
  );

  const activeParkings = parkings.filter((p) => p.status === "active").length;
  const inactiveParkings = parkings.filter((p) => p.status === "inactive").length;

  const refreshing =
    bikesQ.isFetching || parkingsQ.isFetching || ridesQ.isFetching ||
    ticketsQ.isFetching || objectsQ.isFetching;

  const refreshAll = () => {
    bikesQ.refetch(); parkingsQ.refetch(); ridesQ.refetch();
    ticketsQ.refetch(); objectsQ.refetch();
  };

  const toggleLayer = (key: LayerKey) =>
    setLayers((l) => ({ ...l, [key]: !l[key] }));

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-operations-map">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Операции</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Операторская карта</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Мониторинг флота, поездок, парковок и сервисных тикетов на одной карте.
            Только просмотр — редактирование в соответствующих разделах.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshing} data-testid="button-operations-refresh">
          <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
          Обновить
        </Button>
      </header>

      {/* Layer toggles */}
      <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="operations-layer-toggles">
        {LAYER_DEFS.map((def) => {
          const Icon = def.icon;
          const on = layers[def.key] !== false;
          return (
            <Button
              key={def.key}
              variant={on ? "default" : "outline"}
              size="sm"
              onClick={() => toggleLayer(def.key)}
              data-testid={def.testId}
              aria-pressed={on}
            >
              <Icon className="w-4 h-4 mr-2" /> {def.label}
            </Button>
          );
        })}
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-4 lg:gap-6">
        <div className="space-y-3">
          <MapLibreMap
            bikes={bikes}
            parkings={parkings}
            activeRides={activeRides}
            tickets={openTickets}
            mapObjects={activeObjects}
            layers={layers}
            height="64vh"
            className="relative w-full overflow-hidden rounded-xl border border-card-border bg-card"
            selectedBikeId={selection?.kind === "bike" ? selection.id : null}
            onSelectBike={(id) => setSelection({ kind: "bike", id })}
            onSelectParking={(id) => setSelection({ kind: "parking", id })}
            onSelectRide={(id) => setSelection({ kind: "ride", id })}
            onSelectTicket={(id) => setSelection({ kind: "ticket", id })}
          />

          <DetailCard
            selection={selection}
            onClose={() => setSelection(null)}
            bikes={bikes}
            parkings={parkings}
            rides={activeRides}
            tickets={openTickets}
          />
        </div>

        {/* Summary panel */}
        <Card className="p-5 h-fit" data-testid="operations-summary">
          <div className="flex items-center gap-2 mb-4 text-xs uppercase tracking-widest text-muted-foreground">
            <Activity className="w-3.5 h-3.5" /> Сводка
          </div>
          <div className="space-y-2">
            <SummaryRow
              icon={BikeIcon} label="Велосипеды" value={bikes.length}
              href="/admin/bikes" testId="summary-bikes"
            />
            <SummaryRow
              icon={Route} label="Активные поездки" value={activeRides.length}
              href="/admin/rides" testId="summary-rides"
            />
            <SummaryRow
              icon={Wrench} label="Открытые тикеты" value={openTickets.length}
              href="/admin/maintenance" testId="summary-tickets"
            />
            <SummaryRow
              icon={ParkingCircle} label="Активные парковки" value={activeParkings}
              href="/admin/parkings" testId="summary-parkings-active"
            />
            <SummaryRow
              icon={ParkingCircle} label="Неактивные парковки" value={inactiveParkings}
              href="/admin/parkings" testId="summary-parkings-inactive"
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

function SummaryRow({ icon: Icon, label, value, href, testId }: {
  icon: typeof BikeIcon; label: string; value: number; href: string; testId: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="flex items-center gap-3 rounded-md border border-card-border px-3 py-2 hover-elevate"
    >
      <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
      <span className="text-sm font-light flex-1">{label}</span>
      <span className="text-base font-medium tabular-nums">{value}</span>
      <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
    </Link>
  );
}

function DetailCard({ selection, onClose, bikes, parkings, rides, tickets }: {
  selection: Selection;
  onClose: () => void;
  bikes: Bike[];
  parkings: Parking[];
  rides: AdminRide[];
  tickets: Ticket[];
}) {
  if (!selection) return null;

  let title = "";
  let body: React.ReactNode = null;
  let href = "";
  let linkLabel = "";

  if (selection.kind === "bike") {
    const b = bikes.find((x) => x.id === selection.id);
    if (!b) return null;
    title = `Велосипед ${b.id}`;
    href = "/admin/bikes"; linkLabel = "К велосипедам";
    body = (
      <>
        <Detail label="Модель" value={b.model} />
        <Detail label="Статус" value={BIKE_STATUS_LABEL[b.status] ?? b.status} />
        <Detail label="Заряд" value={`${b.battery}%`} />
        {b.parkingId && <Detail label="Парковка" value={b.parkingId} />}
      </>
    );
  } else if (selection.kind === "parking") {
    const p = parkings.find((x) => x.id === selection.id);
    if (!p) return null;
    title = p.name;
    href = "/admin/parkings"; linkLabel = "К парковкам";
    body = (
      <>
        <Detail label="Код" value={p.id} />
        <Detail label="Статус" value={p.status === "active" ? "Активна" : "Неактивна"} />
        <Detail label="Занято / вмест." value={`${p.occupied} / ${p.capacity}`} />
      </>
    );
  } else if (selection.kind === "ride") {
    const r = rides.find((x) => x.id === selection.id);
    if (!r) return null;
    title = `Поездка #${r.id}`;
    href = "/admin/rides"; linkLabel = "К поездкам";
    body = (
      <>
        <Detail label="Велосипед" value={r.bikeId} />
        <Detail label="Райдер" value={r.userName ?? r.userId} />
        <Detail label="Начало" value={fmtDate(r.startedAt)} />
        <Detail label="Стоимость" value={fmtRub(r.cost)} />
      </>
    );
  } else {
    const t = tickets.find((x) => x.id === selection.id);
    if (!t) return null;
    title = `Тикет #${t.id}`;
    href = "/admin/maintenance"; linkLabel = "К сервису";
    body = (
      <>
        <Detail label="Велосипед" value={t.bikeId} />
        <Detail label="Тема" value={t.title || t.kind} />
        <Detail label="Приоритет" value={TICKET_PRIORITY_LABEL[t.priority] ?? t.priority} />
        <Detail label="Статус" value={t.status} />
      </>
    );
  }

  return (
    <Card className="p-4" data-testid="operations-detail-card">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="font-display text-lg font-light">{title}</div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} data-testid="button-operations-detail-close" aria-label="Закрыть">
          <X className="w-4 h-4" />
        </Button>
      </div>
      <div className="space-y-1.5 mb-4">{body}</div>
      <Link href={href} data-testid="link-operations-detail">
        <Button variant="outline" size="sm" className="w-full">
          <ExternalLink className="w-4 h-4 mr-2" /> {linkLabel}
        </Button>
      </Link>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-light text-right">{value}</span>
    </div>
  );
}

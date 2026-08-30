import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Bike, Parking, AdminRide, Ticket, MapObject, Alert } from "@shared/schema";
import { TICKET_CLOSED_STATUSES } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { MapLibreMap, type MapLayers } from "@/components/MapLibreMap";
import { useGeolocation } from "./map/use-geolocation";
import {
  Bike as BikeIcon, MapPin, Route, Wrench,
  ParkingCircle,
} from "lucide-react";
import { DetailCard, type Selection } from "./operations-map/DetailCard";

// Poll layer data on an interval so the map stays live without a manual
// refresh. React Query only swaps in new data — the map instance, zoom and
// center are preserved because MapLibreMap updates from props in place.
const LAYER_POLL_MS = 20_000;

// Status strings that mean a bike is part of the live operational fleet (i.e.
// not soft-deleted). Archived bikes must never reach the operations map.
const VISIBLE_BIKE = (b: Bike) => b.status !== "archived";

type LayerKey = keyof MapLayers;

const LAYER_DEFS: { key: LayerKey; label: string; testId: string; icon: typeof BikeIcon }[] = [
  { key: "parkings", label: "Парковки",   testId: "toggle-layer-parkings", icon: ParkingCircle },
  { key: "bikes",    label: "Велосипеды", testId: "toggle-layer-bikes",    icon: BikeIcon },
  { key: "rides",    label: "Поездки",    testId: "toggle-layer-rides",    icon: Route },
  { key: "tickets",  label: "Тикеты",     testId: "toggle-layer-tickets",  icon: Wrench },
  { key: "objects",  label: "Зоны / маршруты", testId: "toggle-layer-zones", icon: MapPin },
];

export function OperationsMapPage({ embedded = false }: { embedded?: boolean } = {}) {
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/admin/bikes"], refetchInterval: LAYER_POLL_MS });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/admin/parkings"], refetchInterval: LAYER_POLL_MS });
  const ridesQ = useQuery<AdminRide[]>({ queryKey: ["/api/admin/rides"], refetchInterval: LAYER_POLL_MS });
  const ticketsQ = useQuery<Ticket[]>({ queryKey: ["/api/tickets"], refetchInterval: LAYER_POLL_MS });
  const objectsQ = useQuery<MapObject[]>({ queryKey: ["/api/admin/map-objects"], refetchInterval: LAYER_POLL_MS });
  const alertsQ = useQuery<Alert[]>({ queryKey: ["/api/admin/alerts"], refetchInterval: LAYER_POLL_MS });

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
  // Unacknowledged "fall" alerts, for the distinct red "!" map marker.
  const fallenBikeIds = useMemo(
    () => new Set((alertsQ.data ?? []).filter((a) => a.kind === "fall").map((a) => a.bikeId)),
    [alertsQ.data],
  );
  const { geoCenter, handleGeolocate } = useGeolocation();

  const toggleLayer = (key: LayerKey) =>
    setLayers((l) => ({ ...l, [key]: !l[key] }));

  return (
    <div
      className={embedded ? "" : "px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto"}
      data-testid="page-admin-operations-map"
    >
      {!embedded && (
        <header className="mb-6">
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Операции</div>
          <h1 className="font-display font-light text-2xl lg:text-3xl mt-1">
            Операторская карта
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Мониторинг флота, поездок, парковок и сервисных тикетов на одной карте.
            Только просмотр — редактирование в соответствующих разделах.
          </p>
        </header>
      )}

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

      <div className="space-y-3">
        <div className="relative">
          <MapLibreMap
            bikes={bikes}
            parkings={parkings}
            activeRides={activeRides}
            tickets={openTickets}
            mapObjects={activeObjects}
            fallenBikeIds={fallenBikeIds}
            layers={layers}
            center={geoCenter}
            height="64vh"
            className="relative w-full overflow-hidden rounded-xl border border-card-border bg-card"
            selectedBikeId={selection?.kind === "bike" ? selection.id : null}
            onSelectBike={(id) => setSelection({ kind: "bike", id })}
            onSelectParking={(id) => setSelection({ kind: "parking", id })}
            onSelectRide={(id) => setSelection({ kind: "ride", id })}
            onSelectTicket={(id) => setSelection({ kind: "ticket", id })}
          />
          {/* Тот же стиль, что на пользовательской карте (MapPage.tsx) и редакторе карты
           * (MapEditorPage.tsx) — круглая bg-primary с MapPin вместо вторичной кнопки. */}
          <button
            type="button"
            onClick={handleGeolocate}
            aria-label="Моя геопозиция"
            data-testid="button-operations-geolocate"
            className="absolute bottom-4 right-4 z-10 w-12 h-12 rounded-full bg-primary text-black shadow-lg flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
          >
            <MapPin className="w-5 h-5" />
          </button>
        </div>

        <DetailCard
          selection={selection}
          onClose={() => setSelection(null)}
          bikes={bikes}
          parkings={parkings}
          rides={activeRides}
          tickets={openTickets}
        />
      </div>
    </div>
  );
}

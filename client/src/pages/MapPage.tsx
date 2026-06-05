import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import type { Bike, Parking, ZoneRow, Ride, MapObject } from "@shared/schema";
import { YandexMap } from "@/components/YandexMap";
import { QrCode, Bike as BikeIcon } from "lucide-react";

export function MapPage() {
  const [, navigate] = useLocation();
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  const zonesQ = useQuery<ZoneRow[]>({ queryKey: ["/api/zones"] });
  const mapObjectsQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });
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

  const canRent = !!bike && bike.status === "available";

  const goRent = (multi = false) => {
    if (!bike) return;
    navigate(`/rent?bike=${bike.id}${multi ? "&multi=1" : ""}`);
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Map occupies the main area at the top. */}
      <div className="flex-1 min-h-0" data-testid="map-area">
        <YandexMap
          bikes={bikesQ.data ?? []}
          parkings={parkingsQ.data ?? []}
          zones={zonesQ.data ?? []}
          mapObjects={mapObjectsQ.data ?? []}
          ride={rideQ.data ?? null}
          selectedBikeId={selected}
          onSelectBike={setSelected}
          height="100%"
          showLabels={false}
        />
      </div>

      {/* Action section — sits below the map, not overlaying it. Padding
          respects the device safe-area (home indicator / notch) and stays
          compact on short viewports so the scan button is never clipped. */}
      <section
        className="shrink-0 bg-card border-t border-card-border px-4 pt-2 [@media(min-height:700px)]:pt-3"
        style={{
          paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
        }}
        data-testid="action-sheet"
      >
        <div className="mx-auto max-w-md flex items-stretch gap-3">
          {/* Secondary option card */}
          <button
            type="button"
            onClick={() => goRent(true)}
            disabled={!canRent}
            data-testid="button-rent-two-bikes"
            className="flex-1 rounded-2xl bg-background border border-card-border shadow-sm px-4 py-2.5 [@media(min-height:700px)]:py-3 text-left hover-elevate disabled:opacity-50 disabled:pointer-events-none"
          >
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
              <BikeIcon className="w-4 h-4" />
              Доп. опция
            </div>
            <div className="font-display text-sm [@media(min-height:700px)]:text-base font-light mt-0.5 leading-tight">
              Взять два велосипеда
            </div>
          </button>

          {/* Primary round QR scan / rent button */}
          <button
            type="button"
            onClick={() => goRent(false)}
            disabled={!canRent}
            aria-label="Арендовать"
            data-testid="button-rent-qr"
            className="shrink-0 w-16 h-16 [@media(min-height:700px)]:w-20 [@media(min-height:700px)]:h-20 rounded-full bg-brand-sand-deep text-brand-bark shadow-xl flex flex-col items-center justify-center gap-0.5 [@media(min-height:700px)]:gap-1 hover-elevate active:scale-95 transition-transform disabled:opacity-50 disabled:pointer-events-none"
          >
            <QrCode className="w-6 h-6 [@media(min-height:700px)]:w-7 [@media(min-height:700px)]:h-7" />
            <span className="text-[10px] uppercase tracking-widest font-medium">Скан</span>
          </button>
        </div>
        {!canRent && (
          <div
            className="mx-auto max-w-md mt-2 text-center text-xs text-muted-foreground"
            data-testid="text-rent-hint"
          >
            Выберите доступный велосипед на карте.
          </div>
        )}
      </section>
    </div>
  );
}

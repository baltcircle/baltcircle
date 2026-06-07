import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import type { Bike, MapObject } from "@shared/schema";
import { YandexMap } from "@/components/YandexMap";
import { RentalStartModal } from "@/components/RentalStartModal";
import { RegistrationModal } from "@/components/RegistrationModal";
import { useCurrentUser } from "@/hooks/use-current-user";
import { QrCode, Bike as BikeIcon } from "lucide-react";

// Marks that the first-visit registration prompt was already shown on this
// device, so closing it does not re-open on every refresh. Registration itself
// is still enforced server-side via the rent button gate.
const INTRO_SHOWN_KEY = "bc.registration.intro.shown";

export function MapPage() {
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const mapObjectsQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });
  const { isRegistered, isLoading: userLoading } = useCurrentUser();

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

  const [rentalOpen, setRentalOpen] = useState(false);
  const [rentalMulti, setRentalMulti] = useState(false);
  const [regOpen, setRegOpen] = useState(false);

  // Remembers a rental action interrupted by the registration gate, so we can
  // resume it automatically once the rider finishes registering.
  const pendingMulti = useRef<boolean | null>(null);

  // First-visit prompt: once user state has loaded, if the visitor isn't
  // registered and hasn't seen the intro yet, show the closable modal.
  useEffect(() => {
    if (userLoading || isRegistered) return;
    if (localStorage.getItem(INTRO_SHOWN_KEY)) return;
    localStorage.setItem(INTRO_SHOWN_KEY, "1");
    setRegOpen(true);
  }, [userLoading, isRegistered]);

  const openRental = (multi: boolean) => {
    setRentalMulti(multi);
    setRentalOpen(true);
  };

  const goRent = (multi = false) => {
    // Registration gate: unregistered riders must register before the rental
    // flow opens. The attempted action is resumed after successful sign-up.
    if (!isRegistered) {
      pendingMulti.current = multi;
      setRegOpen(true);
      return;
    }
    openRental(multi);
  };

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Map occupies the main area at the top. The public map shows only the
          base Yandex map plus operator-drawn objects saved in /admin/map — no
          app-drawn bike or parking markers. Bike data is still loaded above to
          drive the QR / rental flow. */}
      <div className="flex-1 min-h-0" data-testid="map-area">
        <YandexMap
          mapObjects={mapObjectsQ.data ?? []}
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

          {/* Primary round QR scan / rent button — always tappable so it can
              demonstrate the rental flow; the modal handles the no-bike case. */}
          <button
            type="button"
            onClick={() => goRent(false)}
            aria-label="Сканировать QR"
            data-testid="button-rent-qr"
            className="shrink-0 w-16 h-16 [@media(min-height:700px)]:w-20 [@media(min-height:700px)]:h-20 rounded-full bg-brand-sand-deep text-brand-bark shadow-xl flex flex-col items-center justify-center gap-0.5 [@media(min-height:700px)]:gap-1 hover-elevate active:scale-95 transition-transform"
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

      <RegistrationModal
        open={regOpen}
        onOpenChange={(open) => {
          setRegOpen(open);
          if (!open) pendingMulti.current = null;
        }}
        onRegistered={() => {
          // Resume the rental action that triggered the gate, if any.
          if (pendingMulti.current !== null) {
            const multi = pendingMulti.current;
            pendingMulti.current = null;
            openRental(multi);
          }
        }}
      />

      <RentalStartModal
        open={rentalOpen}
        onOpenChange={setRentalOpen}
        bike={bike ?? availableBikes[0] ?? null}
        multi={rentalMulti}
      />
    </div>
  );
}

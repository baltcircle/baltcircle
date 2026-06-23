import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import type { Bike, MapObject, Parking, Ride } from "@shared/schema";
import { YandexMap } from "@/components/YandexMap";
import { RentalStartModal } from "@/components/RentalStartModal";
import { RegistrationModal } from "@/components/RegistrationModal";
import { QrScanModal } from "@/components/QrScanModal";
import { useCurrentUser } from "@/hooks/use-current-user";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtDuration } from "@/lib/format";
import { PENDING_BIKE_KEY } from "@/lib/pending-bike";
import { Logo } from "@/components/Logo";
import { useTheme } from "@/lib/theme";
import { QrCode, Bike as BikeIcon, User, LifeBuoy, Lock, Clock, ChevronRight, Sun, Moon } from "lucide-react";

// Marks that the first-visit registration prompt was already shown on this
// device, so closing it does not re-open on every refresh. Registration itself
// is still enforced server-side via the rent button gate.
const INTRO_SHOWN_KEY = "bc.registration.intro.shown";

export function MapPage() {
  const toast = useToast();
  const { theme, toggle } = useTheme();
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const mapObjectsQ = useQuery<MapObject[]>({ queryKey: ["/api/map-objects"] });
  // Active, operator-managed parking points. Shown as parking markers on the
  // customer map so riders know where to pick up / return bikes.
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  // Active ride drives the on-map ride card. Polled so the duration/finish
  // state stays fresh while the rider is on the home screen.
  const activeQ = useQuery<Ride | null>({
    queryKey: ["/api/rides/active"],
    refetchInterval: 4000,
  });
  const { isRegistered, isLoading: userLoading } = useCurrentUser();

  const activeRide = activeQ.data ?? null;

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
  const [scanOpen, setScanOpen] = useState(false);

  // Remembers a rental action interrupted by the registration gate, so we can
  // resume it automatically once the rider finishes registering.
  const pendingMulti = useRef<boolean | null>(null);

  // Live duration ticker for the active-ride card.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activeRide) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeRide]);

  // First-visit prompt: once user state has loaded, if the visitor isn't
  // registered and hasn't seen the intro yet, show the closable modal.
  useEffect(() => {
    if (userLoading || isRegistered) return;
    if (localStorage.getItem(INTRO_SHOWN_KEY)) return;
    localStorage.setItem(INTRO_SHOWN_KEY, "1");
    setRegOpen(true);
  }, [userLoading, isRegistered]);

  const endMut = useMutation({
    mutationFn: async (rideId: number) => {
      const res = await apiRequest("POST", `/api/rides/${rideId}/end`);
      return res.json() as Promise<Ride>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rides"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wallet"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      toast.toast({ title: "Поездка завершена", description: "Спасибо, что выбрали TakeRide!" });
    },
    onError: (err: any) => {
      toast.toast({
        title: "Не удалось завершить",
        description: err?.message ?? "Попробуйте ещё раз",
        variant: "destructive",
      });
    },
  });

  // Opens the scan-simulation step. The chosen multi flag is carried through to
  // the rental modal once a bike has been scanned/selected.
  const openScan = (multi: boolean) => {
    setRentalMulti(multi);
    setScanOpen(true);
  };

  const goRent = (multi = false) => {
    // Registration gate: unregistered riders must register before the scan
    // flow opens. The attempted action is resumed after successful sign-up.
    if (!isRegistered) {
      pendingMulti.current = multi;
      setRegOpen(true);
      return;
    }
    openScan(multi);
  };

  // A bike was resolved by the scan modal (QR, manual code, or test bike).
  // Lock it in as the selected bike and continue to the rental-start modal.
  const onBikeScanned = (b: Bike) => {
    setSelected(b.id);
    setRentalOpen(true);
  };

  // Cold-open QR deep link ("/bike/BC-001"): once bikes/user have loaded,
  // resolve the stashed code and either open the rental (registered + bike
  // available) or surface a clear toast. Cleared so it fires only once.
  useEffect(() => {
    if (userLoading || !bikesQ.data) return;
    const code = sessionStorage.getItem(PENDING_BIKE_KEY);
    if (!code) return;
    sessionStorage.removeItem(PENDING_BIKE_KEY);

    const target = bikesQ.data.find((b) => b.id.toUpperCase() === code);
    if (!target) {
      toast.toast({ title: "Велосипед не найден", description: code, variant: "destructive" });
      return;
    }
    if (target.status !== "available") {
      toast.toast({ title: "Велосипед недоступен", description: `${target.id} сейчас занят`, variant: "destructive" });
      return;
    }
    if (!isRegistered) {
      pendingMulti.current = false;
      setRegOpen(true);
      return;
    }
    onBikeScanned(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLoading, bikesQ.data, isRegistered]);

  return (
    <div className="relative flex flex-col h-full min-h-0 overflow-hidden">
      {/* DEPLOY TEST BANNER — remove after confirming changes arrive */}
      <div style={{position:"fixed",top:0,left:0,right:0,zIndex:9999,background:"#ff0000",color:"#fff",fontSize:"20px",fontWeight:"bold",textAlign:"center",padding:"12px"}}>✅ ДЕПЛОЙ РАБОТАЕТ — {new Date().toISOString()}</div>
      {/* Floating header — sits over the map for a clean, full-bleed mobile
          look. TakeRide wordmark on the left, profile button on the right. */}
      <header
        className="absolute top-0 inset-x-0 z-20 flex items-center justify-between gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 pointer-events-none"
        data-testid="home-header"
      >
        <div className="pointer-events-auto flex items-center rounded-full bg-card/90 backdrop-blur border border-card-border shadow-sm pl-2.5 pr-3.5 h-11 text-foreground">
          <Logo />
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={toggle}
            aria-label="Сменить тему"
            data-testid="home-theme-toggle"
            className="flex items-center justify-center w-11 h-11 rounded-full bg-card/90 backdrop-blur border border-card-border shadow-sm text-foreground hover-elevate active:scale-95 transition-transform"
          >
            {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          <Link
            href="/profile"
            aria-label="Профиль"
            data-testid="home-profile-button"
            className="flex items-center justify-center w-11 h-11 rounded-full bg-card/90 backdrop-blur border border-card-border shadow-sm text-foreground hover-elevate active:scale-95 transition-transform"
          >
            <User className="w-5 h-5" />
          </Link>
        </div>
      </header>

      {/* Map fills the screen as the central focus. The public map shows the
          base Yandex map, operator-drawn objects saved in /admin/map, and the
          active operator-managed parking points. Bikes stay hidden on the
          customer map; bike data still loads above to drive the QR / rental
          flow. */}
      <div className="flex-1 min-h-0" data-testid="map-area">
        <YandexMap
          parkings={parkingsQ.data ?? []}
          mapObjects={mapObjectsQ.data ?? []}
          ride={activeRide}
          height="100%"
          showLabels={false}
        />
      </div>

      {/* Bottom action area. Padding respects the device safe-area and stays
          compact on short viewports so nothing is ever clipped or scrolled. */}
      <section
        className="shrink-0 bg-card border-t border-card-border px-4 pt-2 [@media(min-height:700px)]:pt-3"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        data-testid="action-sheet"
      >
        {activeRide ? (
          /* ----- Active-ride state: compact live card with finish button. */
          <div className="mx-auto max-w-md" data-testid="home-active-ride-card">
            <div className="rounded-2xl bg-background border border-card-border shadow-sm px-4 py-2.5 [@media(min-height:700px)]:py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-accent">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent ride-pulse" /> В пути
                  </div>
                  <div className="font-display text-base [@media(min-height:700px)]:text-lg font-light leading-tight truncate" data-testid="text-active-bike">
                    {activeRide.bikeId}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="flex items-center justify-end gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                    <Clock className="w-3 h-3" /> Время
                  </div>
                  <div className="font-display text-base [@media(min-height:700px)]:text-lg font-light tabular-nums" data-testid="text-ride-duration">
                    {fmtDuration(now - activeRide.startedAt)}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => endMut.mutate(activeRide.id)}
                  disabled={endMut.isPending}
                  data-testid="button-end-ride"
                  className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-brand-sand-deep text-brand-bark h-11 font-medium shadow-sm hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
                >
                  <Lock className="w-4 h-4" /> Завершить поездку
                </button>
                <Link
                  href="/rent"
                  data-testid="link-ride-details"
                  aria-label="Подробнее о поездке"
                  className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-background border border-card-border text-muted-foreground hover-elevate active:scale-95 transition-transform"
                >
                  <ChevronRight className="w-5 h-5" />
                </Link>
              </div>
            </div>
          </div>
        ) : (
          /* ----- Idle state: primary scan + secondary two-bikes + help. */
          <div className="mx-auto max-w-md">
            <div className="flex items-stretch gap-3">
              {/* Secondary option card */}
              <button
                type="button"
                onClick={() => goRent(true)}
                disabled={!canRent}
                data-testid="home-secondary-two-bikes"
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

              {/* Primary round QR scan / rent button — always tappable so it
                  can demonstrate the rental flow; the modal and registration
                  gate handle the no-bike / guest cases. */}
              <button
                type="button"
                onClick={() => goRent(false)}
                aria-label={isRegistered ? "Сканировать QR" : "Сканировать QR (нужна регистрация)"}
                data-testid="home-primary-scan"
                className="shrink-0 w-16 h-16 [@media(min-height:700px)]:w-20 [@media(min-height:700px)]:h-20 rounded-full bg-brand-sand-deep text-brand-bark shadow-xl flex flex-col items-center justify-center gap-0.5 [@media(min-height:700px)]:gap-1 hover-elevate active:scale-95 transition-transform"
              >
                <QrCode className="w-6 h-6 [@media(min-height:700px)]:w-7 [@media(min-height:700px)]:h-7" />
                <span className="text-[10px] uppercase tracking-widest font-medium">Скан</span>
              </button>
            </div>

            {/* Single status line: registration hint for guests, otherwise the
                bike-selection hint when no bike is selected. Help link sits on
                the right so the row stays one line and never adds scroll. */}
            <div className="mt-2 flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground truncate" data-testid="text-rent-hint">
                {!isRegistered
                  ? "Для аренды нужна регистрация — нажмите «Скан»."
                  : canRent
                    ? "Готово к старту — нажмите «Скан»."
                    : "Выберите доступный велосипед на карте."}
              </span>
              <Link
                href="/support"
                data-testid="home-help-button"
                className="shrink-0 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover-elevate rounded-md px-1.5 py-0.5"
              >
                <LifeBuoy className="w-3.5 h-3.5" /> Помощь
              </Link>
            </div>
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
          // Resume the rental action that triggered the gate, if any, by
          // entering the scan step the rider was headed toward.
          if (pendingMulti.current !== null) {
            const multi = pendingMulti.current;
            pendingMulti.current = null;
            openScan(multi);
          }
        }}
      />

      <QrScanModal
        open={scanOpen}
        onOpenChange={setScanOpen}
        bikes={bikesQ.data ?? []}
        onBikeSelected={onBikeScanned}
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

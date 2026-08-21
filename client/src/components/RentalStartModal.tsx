import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Bike, PublicPaymentMethod, Reservation } from "@shared/schema";
import {
  TBANK_CONFIG_KEY, PAYMENT_METHODS_KEY, RESERVATION_ACTIVE_KEY, type TbankConfigResponse,
} from "@/lib/payment";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { TARIFFS } from "@shared/geo";
import type { Tariff } from "@shared/geo";
import {
  Bike as BikeIcon, Check, CreditCard, QrCode, Loader2,
  AlertCircle, Smartphone, CalendarClock,
} from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bike: Bike | null;
  multi?: boolean;
}

interface RideInitResponse {
  orderId: string;
  paymentUrl: string | null;
  amountKopecks: number;
  status?: "pending" | "paid" | "failed";
}

interface ChargeSavedCardResponse {
  orderId: string;
  status: "paid" | "pending";
  rideId?: number;
  amountKopecks: number;
}

export function RentalStartModal({ open, onOpenChange, bike, multi }: Props) {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [tariff, setTariff] = useState<Tariff["id"]>("h1");
  // The rider's explicit payment-method pick for this modal session: a saved
  // method id, "hosted" (pay with a fresh card on T-Bank's page), or null
  // meaning "no explicit choice yet — fall back to the newest saved method".
  // Kept separate from the derived `selectedMethodId` below so a stale pick
  // (a card unlinked mid-session) can't silently stick around.
  const [manualMethodId, setManualMethodId] = useState<number | "hosted" | null>(null);

  useEffect(() => {
    if (open) {
      setTariff("h1");
      setManualMethodId(null);
    }
  }, [open]);

  // Idempotency key for /ride/init and /ride/charge-saved-card (audit HIGH
  // #2): retrying the SAME payment attempt (double-click, network drop) must
  // reuse this key so the server replays the original order instead of
  // charging twice. A genuinely NEW attempt — modal reopened, tariff changed,
  // or payment method switched — gets a fresh key so it isn't stuck replaying
  // a stale/failed result.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  // Whether real T-Bank acquiring is configured. When it isn't, we surface a
  // clear "payments are being set up" message instead of offering a flow that
  // would 503. The probe never exposes the terminal key/password.
  const configQ = useQuery<TbankConfigResponse>({
    queryKey: TBANK_CONFIG_KEY,
    enabled: open,
  });
  const paymentsConfigured = configQ.data?.configured ?? false;

  // The rider's linked payment methods, used to offer a one-tap recurring charge
  // against ANY active T-Bank method — a card with a RebillId or an SBP link with
  // an AccountToken — instead of just the first card found.
  const methodsQ = useQuery<PublicPaymentMethod[]>({
    queryKey: PAYMENT_METHODS_KEY,
    enabled: open,
  });
  const activeMethods = (methodsQ.data ?? []).filter(
    (m) => m.status === "active" && m.provider === "tbank"
      && ((m.type === "card" && m.hasRebillId) || (m.type === "sbp" && m.hasAccountToken)),
  );
  // `manualMethodId` wins only while it still points at a method that's still
  // active; otherwise fall back to the newest saved method (list is already
  // sorted newest-first by the API), or the hosted form if none exist.
  const manualStillValid = manualMethodId === "hosted"
    || (manualMethodId != null && activeMethods.some((m) => m.id === manualMethodId));
  const selectedMethodId: number | "hosted" = manualStillValid
    ? (manualMethodId as number | "hosted")
    : (activeMethods[0]?.id ?? "hosted");
  const selectedMethod = selectedMethodId === "hosted"
    ? undefined
    : activeMethods.find((m) => m.id === selectedMethodId);
  const useSavedCard = !!selectedMethod;

  useEffect(() => {
    setIdemKey(crypto.randomUUID());
  }, [open, tariff, selectedMethodId]);

  // The rider's own active reservation ("бронь"), if any — used to gate the
  // "Бронь" button per the one-reservation-at-a-time product rule (a rider who
  // already holds a reservation elsewhere must cancel it or let it expire
  // before booking a different bike; re-booking the SAME bike is redundant).
  const activeReservationQ = useQuery<Reservation | null>({
    queryKey: RESERVATION_ACTIVE_KEY,
    enabled: open,
  });
  const activeReservation = activeReservationQ.data ?? null;
  const hasReservationElsewhere = !!activeReservation && activeReservation.bikeId !== bike?.id;
  const hasReservationForThisBike = !!activeReservation && activeReservation.bikeId === bike?.id;

  // Pay-then-start: create a T-Bank payment for the selected tariff and send the
  // rider to T-Bank's hosted form. The ride only starts after the payment is
  // confirmed (handled server-side on the notification webhook); the rider lands
  // back on /payment-result which polls the order status.
  const payMut = useMutation<RideInitResponse, Error, void>({
    mutationFn: async () => {
      if (!bike) throw new Error("Велосипед не выбран");
      const res = await apiRequest("POST", "/api/payments/tbank/ride/init", {
        bikeId: bike.id,
        tariffId: tariff,
      }, { "Idempotency-Key": idemKey });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.status === "paid") {
        // Rare replay case: this idempotency key already resolved to a paid
        // order (e.g. rider hit Back after paying, then re-submitted). Don't
        // redirect to a stale/expired T-Bank URL — route straight into the ride.
        queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
        onOpenChange(false);
        navigate("/rent");
        return;
      }
      if (data.status === "failed") {
        // This key already resolved to a declined/abandoned payment — its
        // paymentUrl is stale. Force a fresh attempt instead of redirecting.
        setIdemKey(crypto.randomUUID());
        toast.toast({ title: "Оплата не состоялась", description: "Попробуйте ещё раз.", variant: "destructive" });
        return;
      }
      if (!data.paymentUrl) {
        // Reserved by a racing duplicate request but T-Bank hasn't answered yet.
        // Extremely rare (true simultaneous double-submit); ask the rider to
        // retry in a moment rather than crashing on a null redirect.
        toast.toast({ title: "Оплата обрабатывается", description: "Попробуйте ещё раз через несколько секунд." });
        return;
      }
      // Hand off to T-Bank's hosted payment page. The rider returns to
      // /payment-result?orderId=… afterwards. Use location.replace (NOT href) so
      // the T-Bank form REPLACES the current history entry instead of pushing a
      // new one — otherwise pressing Back after payment lands on the T-Bank form,
      // which redirects forward again and traps the rider on the tab.
      window.location.replace(data.paymentUrl);
    },
    onError: (err) => {
      // Fresh key for the next attempt — don't get stuck replaying this failure.
      setIdemKey(crypto.randomUUID());
      toast.toast({ title: "Не удалось перейти к оплате", description: cleanErr(err), variant: "destructive" });
    },
  });

  // One-tap charge against the saved card. On a synchronous "paid" the ride is
  // already started server-side, so we refresh the active-ride query, close the
  // modal and route into the ride. A "pending" charge (e.g. 3DS step-up) sends
  // the rider to the result page which polls until the webhook resolves it.
  const chargeMut = useMutation<ChargeSavedCardResponse, Error, void>({
    mutationFn: async () => {
      if (!bike) throw new Error("Велосипед не выбран");
      const res = await apiRequest("POST", "/api/payments/tbank/ride/charge-saved-card", {
        bikeId: bike.id,
        tariffId: tariff,
        paymentMethodId: selectedMethod?.id,
      }, { "Idempotency-Key": idemKey });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      if (data.status === "paid") {
        toast.toast({ title: "Оплачено", description: "Аренда началась." });
        onOpenChange(false);
        navigate("/rent");
      } else {
        // Deferred — let the result page poll the order to completion.
        navigate(`/payment-result?orderId=${encodeURIComponent(data.orderId)}`);
      }
    },
    onError: (err) => {
      // Fresh key for the next attempt — a replay would just re-return this
      // same decline instead of letting the rider try a fresh charge.
      setIdemKey(crypto.randomUUID());
      toast.toast({ title: "Не удалось списать оплату", description: cleanErr(err), variant: "destructive" });
    },
  });

  // Book the bike for up to RESERVATION_TTL_MS (10 min) without paying yet.
  // Disabled by canBook below when the rider already holds a reservation.
  const bookMut = useMutation<Reservation, Error, void>({
    mutationFn: async () => {
      if (!bike) throw new Error("Велосипед не выбран");
      const res = await apiRequest("POST", "/api/reservations", { bikeId: bike.id });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RESERVATION_ACTIVE_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      toast.toast({ title: "Велосипед забронирован", description: "У вас 10 минут, чтобы начать поездку." });
      onOpenChange(false);
    },
    onError: (err) => {
      toast.toast({ title: "Не удалось забронировать", description: cleanErr(err), variant: "destructive" });
    },
  });

  const submitting = payMut.isPending || chargeMut.isPending;
  const selectedTariff = TARIFFS.find((t) => t.id === tariff);
  // "available" bikes can always be started; a "reserved" bike can ONLY be
  // started by the rider who holds that exact reservation (storage.startRide
  // enforces the same ownership gate server-side — this is just the UI mirror).
  const canPay = !!bike && (bike.status === "available" || hasReservationForThisBike)
    && paymentsConfigured && !submitting;
  const canBook = !!bike && bike.status === "available"
    && !hasReservationElsewhere && !hasReservationForThisBike && !bookMut.isPending;

  function onPrimary() {
    if (useSavedCard) chargeMut.mutate();
    else payMut.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-rental-start">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            <QrCode className="w-5 h-5" /> Начать аренду
          </DialogTitle>
        </DialogHeader>

        {/* Scanned / selected bike info */}
        {bike ? (
          <div className="rounded-xl border border-card-border bg-muted/40 p-4 flex items-center justify-between" data-testid="rental-bike-info">
            <div>
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Велосипед</div>
              <div className="font-display text-xl font-light">{bike.id}</div>
              <div className="text-sm text-muted-foreground">{bike.model}</div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge>
                {hasReservationForThisBike
                  ? "Забронирован вами"
                  : bike.status === "available"
                  ? "Доступен"
                  : bike.status}
              </Badge>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-card-border bg-muted/40 p-4 text-sm text-muted-foreground flex items-center gap-2" data-testid="rental-bike-info">
            <BikeIcon className="w-4 h-4" /> Выберите доступный велосипед на карте или отсканируйте QR.
          </div>
        )}

        {multi && (
          <div className="text-xs text-muted-foreground" data-testid="rental-multi-hint">
            Режим «два велосипеда»: второй велосипед можно отсканировать после начала поездки.
          </div>
        )}

        {/* Tariff grid */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Тариф</div>
          <div className="grid grid-cols-3 gap-2">
            {TARIFFS.map((t) => {
              const active = tariff === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTariff(t.id)}
                  data-testid={`card-tariff-${t.id}`}
                  className={`rounded-xl border p-3 text-left transition-colors hover-elevate ${
                    active ? "border-primary ring-1 ring-primary bg-primary/5" : "border-card-border"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                      Аренда
                    </span>
                    {active && <Check className="w-3.5 h-3.5 text-primary" />}
                  </div>
                  <div className="font-display text-base font-light mt-1 leading-tight">{t.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    <span className="font-medium text-foreground">{t.price}</span> {t.unit}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Graceful state when acquiring isn't configured yet. */}
        {configQ.isLoading ? (
          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5" data-testid="rental-payment-loading">
            <Loader2 className="w-3 h-3 animate-spin" /> Проверяем оплату…
          </div>
        ) : !paymentsConfigured ? (
          <div className="rounded-md bg-destructive/10 text-destructive text-xs p-2.5 flex items-start gap-1.5" data-testid="rental-payment-unconfigured">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Платежи настраиваются. Попробуйте позже.</span>
          </div>
        ) : null}

        {/* Payment method picker: every active saved card/SBP link, newest first,
            plus a "pay with another card" row that opens T-Bank's hosted form.
            Tapping any row re-selects it — a real switch, not a binary toggle. */}
        {paymentsConfigured && (
          <div className="space-y-1.5">
            {activeMethods.length > 0 && <div className="text-sm font-medium">Способ оплаты</div>}
            <div className="rounded-xl border border-card-border bg-muted/40 p-1.5 space-y-1" data-testid="rental-payment-methods">
              {activeMethods.map((m) => {
                const isSelected = selectedMethodId === m.id;
                const MethodIcon = m.type === "sbp" ? Smartphone : CreditCard;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setManualMethodId(m.id)}
                    disabled={submitting}
                    data-testid={`button-payment-method-${m.id}`}
                    className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-left transition-colors hover-elevate ${
                      isSelected ? "bg-primary/10 ring-1 ring-primary" : ""
                    }`}
                  >
                    <MethodIcon className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-medium text-foreground truncate">{m.label}</span>
                    {isSelected && <Check className="w-3.5 h-3.5 text-primary ml-auto shrink-0" />}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setManualMethodId("hosted")}
                disabled={submitting}
                data-testid="button-payment-method-hosted"
                className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-left transition-colors hover-elevate ${
                  selectedMethodId === "hosted" ? "bg-primary/10 ring-1 ring-primary" : ""
                }`}
              >
                <QrCode className="w-3.5 h-3.5 shrink-0" />
                <span className={selectedMethodId === "hosted" ? "font-medium text-foreground" : "text-muted-foreground"}>
                  {activeMethods.length > 0 ? "Оплатить другой картой" : "Оплатить картой на странице Т-Банка"}
                </span>
                {selectedMethodId === "hosted" && <Check className="w-3.5 h-3.5 text-primary ml-auto shrink-0" />}
              </button>
            </div>
          </div>
        )}

        {/* Reservation conflict note: booking THIS bike is blocked while the rider
            holds an active reservation somewhere else. */}
        {hasReservationElsewhere && (
          <div className="rounded-md bg-muted/60 text-muted-foreground text-xs p-2.5 flex items-start gap-1.5" data-testid="rental-reservation-conflict">
            <CalendarClock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>У вас уже есть активная бронь другого велосипеда. Отмените её или дождитесь истечения, чтобы забронировать этот.</span>
          </div>
        )}

        {/* Error state if creating the payment / charging the card / booking fails. */}
        {(payMut.isError || chargeMut.isError || bookMut.isError) && (
          <div className="rounded-md bg-destructive/10 text-destructive text-xs p-2.5 flex items-start gap-1.5" data-testid="rental-start-error">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{cleanErr((payMut.error ?? chargeMut.error ?? bookMut.error) as Error)}</span>
          </div>
        )}

        <DialogFooter className="flex-row gap-2">
          <Button
            className="flex-1 min-w-0 px-2"
            disabled={!canPay}
            onClick={onPrimary}
            data-testid="button-start-rental"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <span className="truncate">
                Начать{selectedTariff ? ` — ${selectedTariff.price} ₽` : ""}
              </span>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1 min-w-0 px-2"
            disabled={!canBook}
            onClick={() => bookMut.mutate()}
            data-testid="button-book-reservation"
            title={
              hasReservationForThisBike
                ? "Велосипед уже забронирован вами"
                : hasReservationElsewhere
                ? "У вас уже есть активная бронь другого велосипеда"
                : undefined
            }
          >
            {bookMut.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <CalendarClock className="w-4 h-4 mr-1.5 shrink-0" />
                <span className="truncate">Бронь</span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// apiRequest throws "<status>: <body>" — pull a human message out of the body.
function cleanErr(e: Error): string {
  const m = e.message.match(/^\d+:\s*([\s\S]*)$/);
  const body = m ? m[1] : e.message;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) return parsed.error;
  } catch {
    // body wasn't JSON; fall through
  }
  return body;
}

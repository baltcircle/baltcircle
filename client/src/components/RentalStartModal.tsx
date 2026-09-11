import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { closeReservationNotifications } from "@/lib/push";
import { cleanErr } from "@/lib/api-error";
import type { Bike, PublicPaymentMethod, Reservation } from "@shared/schema";
import { TEST_RIDE_MIN_MINUTES, TEST_RIDE_MAX_MINUTES } from "@shared/schema";
import {
  TBANK_CONFIG_KEY, PAYMENT_METHODS_KEY, RESERVATION_ACTIVE_KEY, type TbankConfigResponse,
} from "@/lib/payment";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { TARIFFS, MAX_ACTIVE_RIDES_PER_USER } from "@shared/geo";
import type { Tariff } from "@shared/geo";
import type { Ride } from "@shared/schema";
import {
  Bike as BikeIcon, Check, CreditCard, Loader2,
  AlertCircle, Smartphone, CalendarClock, FlaskConical,
} from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bike: Bike | null;
}

/**
 * Пресеты длительности тестовой поездки (operator/admin). Подобраны под
 * проверку пушей окончания аренды: порог не шлётся, если оплаченное окно
 * не длиннее самого порога. Ожидаемый набор стадий для каждого значения
 * закреплён тестами в shared/ride-expiry.test.ts.
 */
const TEST_MINUTE_PRESETS: { minutes: number; hint: string }[] = [
  { minutes: 2, hint: "Только овертайм через 2 мин — быстрый прогон" },
  { minutes: 5, hint: "Только овертайм через 5 мин: окно не длиннее порогов" },
  { minutes: 7, hint: "«За 5 минут» через 2 мин и овертайм через 7 мин" },
  { minutes: 16, hint: "Все три: «за 10» через 6 мин, «за 5» через 11, овертайм через 16" },
  { minutes: 30, hint: "Все три, с запасом на проверку паузы и продления" },
];

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

export function RentalStartModal({ open, onOpenChange, bike }: Props) {
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

  // The rider's own active reservations ("брони") AND active rides — both
  // draw from the same combined MAX_ACTIVE_RIDES_PER_USER budget (shared/geo.ts,
  // 2026-09 product decision), so the "Бронь" button must be gated on the
  // total, not just on reservations. Re-booking the SAME bike the rider
  // already has reserved is still redundant regardless of the total.
  const activeReservationQ = useQuery<Reservation[]>({
    queryKey: RESERVATION_ACTIVE_KEY,
    enabled: open,
  });
  const activeRidesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides/active"],
    enabled: open,
  });
  const activeReservations = activeReservationQ.data ?? [];
  // Бронь этого велосипеда, которую списывает старт аренды: её карточка
  // «осталось 2 мин.» после успешного старта уже не про что — серверного push
  // об аннулировании тут не будет, бронь уходит в статус claimed.
  const claimedReservationId = activeReservations.find((r) => r.bikeId === bike?.id)?.id ?? null;
  const dropClaimedReservationCard = () => {
    if (claimedReservationId !== null) closeReservationNotifications(claimedReservationId);
  };
  const activeRidesCount = activeRidesQ.data?.length ?? 0;
  const hasReservationForThisBike = activeReservations.some((r) => r.bikeId === bike?.id);
  const atCombinedCap = activeReservations.length + activeRidesCount >= MAX_ACTIVE_RIDES_PER_USER;

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
        dropClaimedReservationCard();
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
        dropClaimedReservationCard();
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

  // Test ride (operator/admin only): starts a real ride — real unlock, real
  // GPS/geofence, real tracking, pause/extend/end — but the server forces
  // cost to 0 throughout (POST /api/rides/start-test, requireRole-enforced
  // server-side; this client-side gate is UX only, never the real guard).
  const { isOperator, isAdmin } = useCurrentUser();
  const canStartTest = isOperator || isAdmin;
  // Длительность тестовой поездки в минутах. Пустая строка = окно выбранного
  // тарифа. Пресеты подобраны под проверку пушей окончания: 16 мин — все три
  // порога (T-10, T-5, овертайм), 11 — два последних, 6 — только овертайм.
  const [testMinutes, setTestMinutes] = useState<string>("");
  const parsedTestMinutes = testMinutes.trim() === "" ? null : Number(testMinutes);
  const testMinutesValid =
    parsedTestMinutes === null ||
    (Number.isInteger(parsedTestMinutes)
      && parsedTestMinutes >= TEST_RIDE_MIN_MINUTES
      && parsedTestMinutes <= TEST_RIDE_MAX_MINUTES);
  const testMut = useMutation<Ride, Error, void>({
    mutationFn: async () => {
      if (!bike) throw new Error("Велосипед не выбран");
      const res = await apiRequest("POST", "/api/rides/start-test", {
        bikeId: bike.id,
        tariff,
        ...(parsedTestMinutes !== null ? { durationMinutes: parsedTestMinutes } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      dropClaimedReservationCard();
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      toast.toast({
        title: "Тестовая поездка начата",
        description: parsedTestMinutes !== null
          ? `Оплата не производится. Оплаченное окно — ${parsedTestMinutes} мин.`
          : "Оплата не производится.",
      });
      onOpenChange(false);
      navigate("/rent");
    },
    onError: (err) => {
      toast.toast({ title: "Не удалось начать тестовую поездку", description: cleanErr(err), variant: "destructive" });
    },
  });

  const submitting = payMut.isPending || chargeMut.isPending;
  // "available" bikes can always be started; a "reserved" bike can ONLY be
  // started by the rider who holds that exact reservation (storage.startRide
  // enforces the same ownership gate server-side — this is just the UI mirror).
  const canPay = !!bike && (bike.status === "available" || hasReservationForThisBike)
    && paymentsConfigured && useSavedCard && !submitting;
  const canBook = !!bike && bike.status === "available"
    && !atCombinedCap && !hasReservationForThisBike && !bookMut.isPending;
  const canStartTestRide = canStartTest && !!bike
    && (bike.status === "available" || hasReservationForThisBike) && !testMut.isPending
    && testMinutesValid;

  function onPrimary() {
    // Гатится через canPay: без привязанного способа оплаты кнопка дизаблена, так
    // что hosted-оплата (payMut) больше не затрагивается отсюда.
    if (useSavedCard) chargeMut.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-rental-start">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-light text-center">
            Начать аренду
          </DialogTitle>
        </DialogHeader>

        {/* Scanned / selected bike info */}
        {bike ? (
          <div className="rounded-xl border border-card-border bg-muted/40 p-4 flex items-center justify-between" data-testid="rental-bike-info">
            <div className="font-display text-xl font-light">{bike.id}</div>
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

        {/* Tariff grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {TARIFFS.map((t) => {
            const active = tariff === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTariff(t.id)}
                data-testid={`card-tariff-${t.id}`}
                className={`relative rounded-xl border p-3 text-center transition-colors hover-elevate ${
                  active ? "border-primary ring-1 ring-primary bg-primary/5" : "border-card-border"
                }`}
              >
                {t.test && (
                  <span className="absolute top-1.5 left-1.5 px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[9px] uppercase tracking-widest font-semibold">
                    тест
                  </span>
                )}
                {active && <Check className="absolute top-2 right-2 w-3.5 h-3.5 text-primary" />}
                <div className="font-display text-lg font-light leading-tight">{t.name}</div>
                <div className="text-lg text-muted-foreground mt-1">
                  <span className="font-medium text-foreground">{t.price}</span> {t.unit}
                </div>
              </button>
            );
          })}
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

        {/* Payment method picker: только сохранённые способы оплаты — никакого “hosted”-варианта
            с переходом на форму Т-Банка: без привязанного способа оплаты сканирование QR
            вообще недоступно (гатится отдельно), так что до этого экрана райдер всегда уже
            имеет хотя бы один активный метод. Тап по строке заново выбирает ее. */}
        {paymentsConfigured && activeMethods.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-base font-medium">Способ оплаты</div>
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
                    className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2.5 text-sm text-left transition-colors hover-elevate ${
                      isSelected ? "bg-primary/10 ring-1 ring-primary" : ""
                    }`}
                  >
                    <MethodIcon className="w-4 h-4 shrink-0" />
                    <span className="font-medium text-foreground truncate">{m.label}</span>
                    {isSelected && <Check className="w-4 h-4 text-primary ml-auto shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Без привязанного способа оплаты здесь нет ни списка методов, ни hosted-кнопки —
            райдер до этого модального окна не дойдёт (QR-сканер гатит доступ отдельно).
            Страхует на случай, если модалка всё же открылась таким райдером — не даёт тихо
            улететь в hosted-оплату без выбора и объясняет, что нужно сделать. */}
        {paymentsConfigured && activeMethods.length === 0 && (
          <div className="rounded-md bg-muted/60 text-muted-foreground text-xs p-2.5 flex items-start gap-1.5" data-testid="rental-no-payment-method">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Сначала привяжите карту или счёт в настройках профиля — без сохранённого способа оплаты начать аренду нельзя.</span>
          </div>
        )}

        {/* Reservation/ride cap note: booking THIS bike is blocked once the rider
            is at the combined MAX_ACTIVE_RIDES_PER_USER budget (shared/geo.ts). */}
        {atCombinedCap && !hasReservationForThisBike && (
          <div className="rounded-md bg-muted/60 text-muted-foreground text-xs p-2.5 flex items-start gap-1.5" data-testid="rental-reservation-conflict">
            <CalendarClock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>У вас уже максимум активных бронирований и поездок ({MAX_ACTIVE_RIDES_PER_USER}). Отмените бронь, дождитесь её истечения или завершите поездку, чтобы забронировать этот велосипед.</span>
          </div>
        )}

        {/* Error state if creating the payment / charging the card / booking fails. */}
        {(payMut.isError || chargeMut.isError || bookMut.isError || testMut.isError) && (
          <div className="rounded-md bg-destructive/10 text-destructive text-xs p-2.5 flex items-start gap-1.5" data-testid="rental-start-error">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{cleanErr((payMut.error ?? chargeMut.error ?? bookMut.error ?? testMut.error) as Error)}</span>
          </div>
        )}

        {/* Operator/admin-only: full real ride lifecycle, cost forced to 0
            server-side, excluded from rider/staff ride-history feeds. */}
        {canStartTest && (
          <div className="space-y-2 rounded-xl border border-dashed border-card-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-widest text-muted-foreground">Длительность теста</span>
              <span className="text-[11px] text-muted-foreground">{TEST_RIDE_MIN_MINUTES}–{TEST_RIDE_MAX_MINUTES} мин</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TEST_MINUTE_PRESETS.map((preset) => {
                const active = parsedTestMinutes === preset.minutes;
                return (
                  <button
                    key={preset.minutes}
                    type="button"
                    onClick={() => setTestMinutes(active ? "" : String(preset.minutes))}
                    title={preset.hint}
                    data-testid={`button-test-minutes-${preset.minutes}`}
                    className={`rounded-lg border px-2.5 py-1 text-xs transition-colors hover-elevate ${
                      active ? "border-primary bg-primary/10 text-primary" : "border-card-border text-muted-foreground"
                    }`}
                  >
                    {preset.minutes} мин
                  </button>
                );
              })}
            </div>
            <input
              type="number"
              inputMode="numeric"
              min={TEST_RIDE_MIN_MINUTES}
              max={TEST_RIDE_MAX_MINUTES}
              step={1}
              value={testMinutes}
              onChange={(e) => setTestMinutes(e.target.value)}
              placeholder="По тарифу"
              aria-label="Длительность тестовой поездки в минутах"
              data-testid="input-test-minutes"
              className={`w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary ${
                testMinutesValid ? "border-card-border" : "border-destructive"
              }`}
            />
            {!testMinutesValid && (
              <div className="text-[11px] text-destructive" data-testid="text-test-minutes-error">
                Целое число от {TEST_RIDE_MIN_MINUTES} до {TEST_RIDE_MAX_MINUTES} минут.
              </div>
            )}
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={!canStartTestRide}
              onClick={() => testMut.mutate()}
              data-testid="button-start-test-ride"
            >
              {testMut.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <FlaskConical className="w-4 h-4 mr-1.5 shrink-0" />
                  <span className="truncate">
                    Тестовая поездка (бесплатно){parsedTestMinutes !== null && testMinutesValid ? ` — ${parsedTestMinutes} мин` : ""}
                  </span>
                </>
              )}
            </Button>
          </div>
        )}

        <DialogFooter className="flex-row gap-2">
          <Button
            className="flex-1 min-w-0 px-2 text-base"
            disabled={!canPay}
            onClick={onPrimary}
            data-testid="button-start-rental"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <span className="truncate">Начать</span>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1 min-w-0 px-2 text-base"
            disabled={!canBook}
            onClick={() => bookMut.mutate()}
            data-testid="button-book-reservation"
            title={
              hasReservationForThisBike
                ? "Велосипед уже забронирован вами"
                : atCombinedCap
                ? `У вас уже максимум активных бронирований и поездок (${MAX_ACTIVE_RIDES_PER_USER})`
                : undefined
            }
          >
            {bookMut.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <span className="truncate">Бронь</span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


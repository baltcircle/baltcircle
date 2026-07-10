import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Bike, PaymentMethod } from "@shared/schema";
import {
  TBANK_CONFIG_KEY, PAYMENT_METHODS_KEY, type TbankConfigResponse,
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
  AlertCircle, ShieldAlert, MapPin, LifeBuoy,
} from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bike: Bike | null;
  multi?: boolean;
}

interface RideInitResponse {
  orderId: string;
  paymentUrl: string;
  amountKopecks: number;
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
  // When the rider has a saved card we default to charging it; this lets them
  // opt into the hosted form ("pay with another card") instead.
  const [useOtherCard, setUseOtherCard] = useState(false);

  useEffect(() => {
    if (open) {
      setTariff("h1");
      setUseOtherCard(false);
    }
  }, [open]);

  // Whether real T-Bank acquiring is configured. When it isn't, we surface a
  // clear "payments are being set up" message instead of offering a flow that
  // would 503. The probe never exposes the terminal key/password.
  const configQ = useQuery<TbankConfigResponse>({
    queryKey: TBANK_CONFIG_KEY,
    enabled: open,
  });
  const paymentsConfigured = configQ.data?.configured ?? false;

  // The rider's linked payment methods, used to detect a saved card eligible for
  // a one-tap recurring charge (active T-Bank card with a RebillId).
  const methodsQ = useQuery<PaymentMethod[]>({
    queryKey: PAYMENT_METHODS_KEY,
    enabled: open,
  });
  const savedCard = (methodsQ.data ?? []).find(
    (m) => m.type === "card" && m.status === "active" && m.provider === "tbank" && !!m.rebillId,
  );
  const useSavedCard = !!savedCard && !useOtherCard;

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
      });
      return res.json();
    },
    onSuccess: (data) => {
      // Hand off to T-Bank's hosted payment page. The rider returns to
      // /payment-result?orderId=… afterwards. Use location.replace (NOT href) so
      // the T-Bank form REPLACES the current history entry instead of pushing a
      // new one — otherwise pressing Back after payment lands on the T-Bank form,
      // which redirects forward again and traps the rider on the tab.
      window.location.replace(data.paymentUrl);
    },
    onError: (err) => {
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
        paymentMethodId: savedCard?.id,
      });
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
      toast.toast({ title: "Не удалось списать оплату", description: cleanErr(err), variant: "destructive" });
    },
  });

  const submitting = payMut.isPending || chargeMut.isPending;
  const selectedTariff = TARIFFS.find((t) => t.id === tariff);
  const canPay = !!bike && bike.status === "available" && paymentsConfigured && !submitting;

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
              <Badge>{bike.status === "available" ? "Доступен" : bike.status}</Badge>
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

        {/* Payment explainer. The rider pays the tariff up front on T-Bank's
            hosted page; the ride starts after the payment is confirmed. */}
        <div className="rounded-xl border border-card-border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1" data-testid="rental-payment-explainer">
          <div className="flex items-start gap-1.5">
            <CreditCard className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Оплата проходит на защищённой странице Т-Банка. Данные карты вводятся
              только там — мы их не получаем и не храним.
            </span>
          </div>
          <div className="flex items-start gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Аренда начнётся автоматически после подтверждения оплаты.</span>
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

        {/* Concise pre-ride rules. */}
        <ul className="space-y-1.5 text-xs text-muted-foreground" data-testid="rental-rules">
          <li className="flex items-start gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Проверьте тормоза перед стартом.
          </li>
          <li className="flex items-start gap-1.5">
            <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Завершайте поездку в разрешённой зоне.
          </li>
          <li className="flex items-start gap-1.5">
            <LifeBuoy className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Что-то не так — обратитесь в поддержку.
          </li>
        </ul>

        {/* Saved card: when present, show it as the default payment source with a
            one-tap charge, plus an opt-out to the hosted form. */}
        {paymentsConfigured && savedCard && (
          <div className="rounded-xl border border-card-border bg-muted/40 p-3 text-xs space-y-1.5" data-testid="rental-saved-card">
            <div className="flex items-center gap-2">
              <CreditCard className="w-3.5 h-3.5 shrink-0" />
              <span className="font-medium text-foreground">{savedCard.label}</span>
              {useSavedCard && <Check className="w-3.5 h-3.5 text-primary ml-auto" />}
            </div>
            <button
              type="button"
              className="text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setUseOtherCard((v) => !v)}
              disabled={submitting}
              data-testid="button-toggle-other-card"
            >
              {useSavedCard ? "Оплатить другой картой" : "Списать с сохранённой карты"}
            </button>
          </div>
        )}

        {/* Error state if creating the payment / charging the card fails. */}
        {(payMut.isError || chargeMut.isError) && (
          <div className="rounded-md bg-destructive/10 text-destructive text-xs p-2.5 flex items-start gap-1.5" data-testid="rental-start-error">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{cleanErr((payMut.error ?? chargeMut.error) as Error)}</span>
          </div>
        )}

        <DialogFooter>
          <Button
            className="w-full"
            disabled={!canPay}
            onClick={onPrimary}
            data-testid="button-start-rental"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {useSavedCard ? "Списываем оплату…" : "Переходим к оплате…"}
              </>
            ) : useSavedCard ? (
              <>
                <CreditCard className="w-4 h-4 mr-2" />
                Начать аренду — списать{selectedTariff ? ` ${selectedTariff.price} ₽` : ""}
              </>
            ) : (
              <>
                <CreditCard className="w-4 h-4 mr-2" />
                Оплатить и начать аренду{selectedTariff ? ` — ${selectedTariff.price} ₽` : ""}
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

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Bike, PaymentMethod, Ride } from "@shared/schema";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { TARIFFS } from "@shared/geo";
import type { Tariff } from "@shared/geo";
import {
  Bike as BikeIcon, Battery, Check, CreditCard, QrCode, Loader2,
  AlertCircle, ShieldAlert, ShieldCheck, MapPin, LifeBuoy,
} from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bike: Bike | null;
  multi?: boolean;
}

export function RentalStartModal({ open, onOpenChange, bike, multi }: Props) {
  const toast = useToast();
  const [tariff, setTariff] = useState<Tariff["id"]>("h1");

  useEffect(() => {
    if (open) setTariff("h1");
  }, [open]);

  // Payment-method status gates the rental start. The query only runs while the
  // modal is open to avoid spurious fetches on the home screen.
  const methodsQ = useQuery<PaymentMethod[]>({
    queryKey: ["/api/payment-methods"],
    enabled: open,
  });
  const hasPaymentMethod = (methodsQ.data?.length ?? 0) > 0;

  const startMut = useMutation<Ride, Error, void>({
    mutationFn: async () => {
      if (!bike) throw new Error("Велосипед не выбран");
      const res = await apiRequest("POST", "/api/rides/start", {
        bikeId: bike.id,
        tariff,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/rides/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      onOpenChange(false);
      toast.toast({ title: "Поездка начата", description: "Замок разблокирован, можно ехать!" });
    },
    onError: (err) => {
      toast.toast({ title: "Не удалось начать поездку", description: cleanErr(err), variant: "destructive" });
    },
  });

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
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Battery className="w-3.5 h-3.5" /> {bike.battery}%
              </span>
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

        {/* Payment-method status. Without a linked method the rental is gated
            and a clear CTA links to /payment-methods. */}
        {methodsQ.isLoading ? (
          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5" data-testid="rental-payment-loading">
            <Loader2 className="w-3 h-3 animate-spin" /> Проверяем способ оплаты…
          </div>
        ) : hasPaymentMethod ? (
          <div className="text-[11px] text-muted-foreground flex items-center gap-1.5" data-testid="rental-payment-ok">
            <ShieldCheck className="w-3 h-3 text-primary" /> Способ оплаты привязан. Оплата спишется после поездки (MVP — списание имитируется).
          </div>
        ) : (
          <div
            className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2"
            data-testid="rental-payment-required"
          >
            <div className="text-sm font-medium flex items-center gap-1.5">
              <CreditCard className="w-4 h-4" /> Нужен способ оплаты
            </div>
            <div className="text-xs text-muted-foreground">
              Чтобы начать аренду, привяжите карту или подключите СБП.
            </div>
            <Button asChild variant="outline" size="sm" className="w-full">
              <Link href="/payment-methods" data-testid="link-add-payment-from-rental">
                <CreditCard className="w-4 h-4 mr-2" /> Добавить способ оплаты
              </Link>
            </Button>
          </div>
        )}

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

        {/* Error state if the start API fails. */}
        {startMut.isError && (
          <div className="rounded-md bg-destructive/10 text-destructive text-xs p-2.5 flex items-start gap-1.5" data-testid="rental-start-error">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{startMut.error ? cleanErr(startMut.error) : "Не удалось начать поездку. Попробуйте ещё раз."}</span>
          </div>
        )}

        <DialogFooter>
          <Button
            className="w-full"
            disabled={!bike || bike.status !== "available" || !hasPaymentMethod || startMut.isPending}
            onClick={() => startMut.mutate()}
            data-testid="button-start-rental"
          >
            {startMut.isPending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Начинаем…</>
            ) : (
              <><QrCode className="w-4 h-4 mr-2" /> Начать аренду</>
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

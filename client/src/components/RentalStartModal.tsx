import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Bike, Ride } from "@shared/schema";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { TARIFFS } from "@shared/geo";
import type { Tariff } from "@shared/geo";
import { Bike as BikeIcon, Battery, Check, CreditCard, QrCode } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bike: Bike | null;
  multi?: boolean;
}

export function RentalStartModal({ open, onOpenChange, bike, multi }: Props) {
  const toast = useToast();
  const [tariff, setTariff] = useState<Tariff["id"]>("payg");

  useEffect(() => {
    if (open) setTariff("payg");
  }, [open]);

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
      toast.toast({ title: "Не удалось начать поездку", description: err?.message ?? "Ошибка", variant: "destructive" });
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
                      {t.id === "payg" ? "Минуты" : t.id === "day" ? "Сутки" : "Месяц"}
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

        <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <CreditCard className="w-3 h-3" /> Оплата спишется с привязанной карты после поездки (MVP — списание имитируется).
        </div>

        <DialogFooter>
          <Button
            className="w-full"
            disabled={!bike || bike.status !== "available" || startMut.isPending}
            onClick={() => startMut.mutate()}
            data-testid="button-start-rental"
          >
            <QrCode className="w-4 h-4 mr-2" /> Начать аренду
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

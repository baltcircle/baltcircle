import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, Loader2, PlusCircle } from "lucide-react";
import { TARIFFS, tariffPriceKopecks } from "@shared/geo";
import type { Tariff } from "@shared/geo";
import { fmtRub } from "@/lib/format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (tariff: Tariff["id"]) => void;
  pending: boolean;
}

/** Всегда доступно, включая во время паузы — продление не зависит от статуса паузы. */
export function ExtendRideDialog({ open, onOpenChange, onConfirm, pending }: Props) {
  const [tariff, setTariff] = useState<Tariff["id"]>("h1");

  return (
    <Dialog open={open} onOpenChange={(v) => !pending && onOpenChange(v)}>
      <DialogContent data-testid="dialog-extend-ride">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            <PlusCircle className="w-5 h-5" /> Продлить аренду
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          {TARIFFS.map((t) => {
            const active = tariff === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTariff(t.id)}
                data-testid={`card-extend-tariff-${t.id}`}
                className={`rounded-xl border p-3 text-left transition-colors hover-elevate ${
                  active ? "border-primary ring-1 ring-primary bg-primary/5" : "border-card-border"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Ещё</span>
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

        <DialogFooter>
          <Button
            className="w-full"
            disabled={pending}
            onClick={() => onConfirm(tariff)}
            data-testid="button-confirm-extend"
          >
            {pending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Продлеваем…
              </>
            ) : (
              `Продлить — списать ${fmtRub(tariffPriceKopecks(TARIFFS.find((t) => t.id === tariff)!))}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

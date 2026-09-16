import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, Loader2 } from "lucide-react";
import { TARIFFS } from "@shared/geo";
import type { Tariff } from "@shared/geo";

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
          <DialogTitle className="font-display text-xl font-light text-center">
            Продлить аренду
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {TARIFFS.map((t) => {
            const active = tariff === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTariff(t.id)}
                data-testid={`card-extend-tariff-${t.id}`}
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
              "Продлить"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

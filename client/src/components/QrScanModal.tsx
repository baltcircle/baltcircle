import { useEffect, useState } from "react";
import type { Bike } from "@shared/schema";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QrCode, ScanLine, Bike as BikeIcon } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Available bikes used to resolve a typed code and to pick a test bike.
  bikes: Bike[];
  // Called once a bike has been "scanned" / chosen, to continue into rental.
  onBikeSelected: (bike: Bike) => void;
}

// Pre-camera scan simulation. No real camera permission is requested yet — this
// is a polished placeholder that resolves a bike either via a manual code or a
// one-tap test bike, then hands the chosen bike back to the caller. The camera
// viewport markup is ready to be swapped for a real scanner later.
export function QrScanModal({ open, onOpenChange, bikes, onBikeSelected }: Props) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCode("");
      setError(null);
    }
  }, [open]);

  const availableBikes = bikes.filter(b => b.status === "available");

  const selectBike = (bike: Bike) => {
    onOpenChange(false);
    onBikeSelected(bike);
  };

  const confirmCode = () => {
    const normalized = code.trim().toUpperCase();
    if (!normalized) {
      setError("Введите код велосипеда");
      return;
    }
    const match = bikes.find(b => b.id.toUpperCase() === normalized);
    if (!match) {
      setError("Велосипед с таким кодом не найден");
      return;
    }
    if (match.status !== "available") {
      setError("Этот велосипед сейчас недоступен");
      return;
    }
    selectBike(match);
  };

  const useTestBike = () => {
    const bike = availableBikes[0];
    if (!bike) {
      setError("Нет доступных велосипедов для теста");
      return;
    }
    selectBike(bike);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-qr-scan">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            <QrCode className="w-5 h-5" /> Сканирование QR
          </DialogTitle>
          <DialogDescription>
            Наведите камеру на QR-код велосипеда
          </DialogDescription>
        </DialogHeader>

        {/* Camera viewport placeholder — ready to host a real scanner later. */}
        <div className="relative aspect-square w-full max-w-[240px] mx-auto rounded-2xl border border-card-border bg-muted/40 overflow-hidden">
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <QrCode className="w-16 h-16 opacity-40" />
          </div>
          {/* Corner brackets + scan line for a familiar scanner feel. */}
          <div className="absolute inset-5 pointer-events-none">
            <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-primary rounded-tl-md" />
            <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-primary rounded-tr-md" />
            <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-primary rounded-bl-md" />
            <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-primary rounded-br-md" />
          </div>
          <ScanLine className="absolute inset-x-6 top-1/2 -translate-y-1/2 w-auto h-6 text-primary/70" />
        </div>

        {/* Manual fallback: enter the code printed on the bike. */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Не сканируется? Введите код вручную</div>
          <div className="flex items-center gap-2">
            <Input
              value={code}
              onChange={(e) => { setCode(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") confirmCode(); }}
              placeholder="Напр. BC-014"
              autoCapitalize="characters"
              data-testid="input-bike-code"
            />
            <Button
              type="button"
              variant="outline"
              onClick={confirmCode}
              data-testid="button-confirm-bike-code"
            >
              ОК
            </Button>
          </div>
          {error && (
            <div className="text-xs text-destructive" data-testid="qr-scan-error">{error}</div>
          )}
        </div>

        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={useTestBike}
          data-testid="button-use-test-bike"
        >
          <BikeIcon className="w-4 h-4 mr-2" /> Использовать тестовый велосипед
        </Button>
      </DialogContent>
    </Dialog>
  );
}

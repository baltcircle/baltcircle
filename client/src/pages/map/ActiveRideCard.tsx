import { Clock, Lock, Route } from "lucide-react";
import type { Ride } from "@shared/schema";
import { RideTimer } from "@/components/RideTimer";
import { fmtDistance, fmtRub } from "@/lib/format";

interface ActiveRideCardProps {
  ride: Ride;
  onEnd: () => void;
  ending: boolean;
}

export function ActiveRideCard({ ride, onEnd, ending }: ActiveRideCardProps) {
  return (
    <div
      className="rounded-2xl bg-card/95 text-card-foreground backdrop-blur-sm shadow-xl px-4 py-3"
      data-testid="home-active-ride-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-accent">
            <span className="w-1.5 h-1.5 rounded-full bg-accent ride-pulse" /> В пути
          </div>
          <div className="font-display text-base font-light leading-tight truncate" data-testid="text-active-bike">
            {ride.bikeId}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Стоимость</div>
          <div className="font-display text-base font-light tabular-nums" data-testid="text-ride-cost">
            {fmtRub(ride.cost ?? 0)}
          </div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-background/50 border border-card-border px-3 py-2">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            <Clock className="w-3 h-3" /> Время
          </div>
          <div className="font-display text-base font-light tabular-nums mt-0.5" data-testid="text-ride-duration">
            <RideTimer startedAt={ride.startedAt} />
          </div>
        </div>
        <div className="rounded-xl bg-background/50 border border-card-border px-3 py-2">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            <Route className="w-3 h-3" /> Расстояние
          </div>
          <div className="font-display text-base font-light tabular-nums mt-0.5" data-testid="text-ride-distance">
            {fmtDistance(ride.distanceM ?? 0)}
          </div>
        </div>
      </div>
      <div className="mt-2">
        <button
          type="button"
          onClick={onEnd}
          disabled={ending}
          data-testid="button-end-ride"
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand-sand-deep text-brand-bark h-11 font-medium shadow-sm hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          <Lock className="w-4 h-4" /> Завершить поездку
        </button>
      </div>
    </div>
  );
}

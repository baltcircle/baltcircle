import { Route } from "lucide-react";
import type { Ride } from "@shared/schema";
import { fmtDistance } from "@/lib/format";

interface SecondaryRideBarProps {
  ride: Ride;
  onFocus: () => void;
  onExtend: () => void;
  extending: boolean;
}

/**
 * Компактная полоса для второй одновременной аренды (не в фокусе) — полная
 * ActiveRideCard в этот момент показывает первую (сфокусированную) поездку.
 * «Продолжить» переключает фокус на эту поездку (полная карточка/пауза/завершение
 * доступны только у сфокусированной поездки); «Продлить» открывает диалог
 * продления сразу для этой поездки, без переключения фокуса.
 */
export function SecondaryRideBar({ ride, onFocus, onExtend, extending }: SecondaryRideBarProps) {
  const paused = ride.pausedAt != null;

  return (
    <div
      className="rounded-2xl bg-card/95 text-card-foreground backdrop-blur-sm shadow-xl px-4 py-2.5 flex items-center justify-between gap-3"
      data-testid="secondary-ride-bar"
    >
      <div className="min-w-0 flex items-center gap-3">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${paused ? "bg-amber-500" : "bg-green-500 ride-pulse"}`}
        />
        <div className="min-w-0">
          <div className="font-display text-sm font-light truncate" data-testid="text-secondary-bike">
            {ride.bikeId}
          </div>
          <div
            className="flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
            data-testid="text-secondary-distance"
          >
            <Route className="w-3 h-3" /> {fmtDistance(ride.distanceM ?? 0)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onExtend}
          disabled={extending}
          data-testid="button-secondary-extend"
          className="h-9 px-3 rounded-full bg-muted text-xs font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          Продлить
        </button>
        <button
          type="button"
          onClick={onFocus}
          data-testid="button-secondary-focus"
          className="h-9 px-3 rounded-full bg-primary text-black text-xs font-medium hover-elevate active:scale-[0.98] transition-transform"
        >
          Продолжить
        </button>
      </div>
    </div>
  );
}

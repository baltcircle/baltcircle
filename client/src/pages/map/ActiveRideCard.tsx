import { useState } from "react";
import { Lock, Route, Pause, Play, PlusCircle, Loader2 } from "lucide-react";
import type { Ride } from "@shared/schema";
import type { Tariff } from "@shared/geo";
import { RideTimer } from "@/components/RideTimer";
import { LiveOverage } from "@/components/LiveOverage";
import { ExtendRideDialog } from "@/components/ExtendRideDialog";
import { fmtDistance } from "@/lib/format";

interface ActiveRideCardProps {
  ride: Ride;
  onEnd: () => void;
  ending: boolean;
  onPause: () => void;
  onResume: () => void;
  pausing: boolean;
  resuming: boolean;
  /** true while waiting for the OMNI lock to report a physical closure. */
  awaitingLockClose: boolean;
  onExtend: (tariff: Tariff["id"]) => void;
  extending: boolean;
}

export function ActiveRideCard({
  ride, onEnd, ending, onPause, onResume, pausing, resuming, awaitingLockClose, onExtend, extending,
}: ActiveRideCardProps) {
  const [extendOpen, setExtendOpen] = useState(false);
  const paused = ride.pausedAt != null;

  return (
    <div
      className="rounded-2xl bg-card/95 text-card-foreground backdrop-blur-sm shadow-xl px-4 py-3"
      data-testid="home-active-ride-card"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-accent">
            <span className={`w-1.5 h-1.5 rounded-full bg-accent ${paused ? "" : "ride-pulse"}`} />
            {paused ? "На паузе" : "В пути"}
          </div>
          <div className="font-display text-base font-light leading-tight tabular-nums" data-testid="text-ride-duration">
            <RideTimer ride={ride} />
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Овертайм</div>
          <div className="font-display text-base font-light tabular-nums" data-testid="text-ride-overage">
            <LiveOverage ride={ride} />
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-background/50 border border-card-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Код велосипеда</div>
          <div className="font-display text-base font-light truncate mt-0.5" data-testid="text-active-bike">
            {ride.bikeId}
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

      {awaitingLockClose && (
        <div
          className="mt-2 rounded-xl bg-accent/10 text-accent px-3 py-2 text-xs flex items-center gap-2"
          data-testid="text-awaiting-lock-close"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          Закройте замок велосипеда, чтобы поставить поездку на паузу
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={paused || awaitingLockClose ? onResume : onPause}
          disabled={pausing || resuming}
          data-testid={paused ? "button-resume-ride" : "button-pause-ride"}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-muted h-11 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          {pausing || resuming ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : paused || awaitingLockClose ? (
            <Play className="w-4 h-4" />
          ) : (
            <Pause className="w-4 h-4" />
          )}
          {paused ? "Продолжить" : awaitingLockClose ? "Отмена" : "Пауза"}
        </button>
        <button
          type="button"
          onClick={() => setExtendOpen(true)}
          disabled={extending}
          data-testid="button-extend-ride"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-muted h-11 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          <PlusCircle className="w-4 h-4" /> Продлить
        </button>
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

      <ExtendRideDialog
        open={extendOpen}
        onOpenChange={setExtendOpen}
        pending={extending}
        onConfirm={(tariff) => {
          onExtend(tariff);
          setExtendOpen(false);
        }}
      />
    </div>
  );
}

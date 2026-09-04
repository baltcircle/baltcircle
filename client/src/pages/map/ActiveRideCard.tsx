import { useState } from "react";
import { Lock, Route, Pause, PlusCircle, Loader2, X, Bike } from "lucide-react";
import { PauseGraceCountdown } from "@/components/PauseGraceCountdown";
import type { Ride } from "@shared/schema";
import type { Tariff } from "@shared/geo";
import { RideTimer } from "@/components/RideTimer";
import { LiveOverage } from "@/components/LiveOverage";
import { ExtendRideDialog } from "@/components/ExtendRideDialog";
import { AwaitingLockCloseDialog } from "@/components/AwaitingLockCloseDialog";
import { fmtDistance } from "@/lib/format";
import { OVERAGE_MINUTE_PRICE } from "@shared/geo";
import { cn } from "@/lib/utils";

interface ActiveRideCardProps {
  ride: Ride;
  onEnd: () => void;
  ending: boolean;
  onPause: () => void;
  onResume: () => void;
  pausing: boolean;
  resuming: boolean;
  /** true while waiting for the OMNI lock to report a physical closure (pause flow). */
  awaitingLockClose: boolean;
  /** true while waiting for the OMNI lock to report a physical closure (end flow). */
  awaitingEndLockClose: boolean;
  onCancelEnd: () => void;
  cancellingEnd: boolean;
  onExtend: (tariff: Tariff["id"]) => void;
  extending: boolean;
  /** true when the rider has room for a second simultaneous ride (< max active). */
  showAddSecondRide?: boolean;
  onAddSecondRide?: () => void;
  /** true when the rider has two simultaneous active rides — shows the 1/2 slot switcher. */
  showRideSwitcher?: boolean;
  /** which ride slot (1 or 2) this card is currently displaying. */
  activeSlot?: 1 | 2;
  onSelectSlot?: (slot: 1 | 2) => void;
}

export function ActiveRideCard({
  ride, onEnd, ending, onPause, onResume, pausing, resuming, awaitingLockClose,
  awaitingEndLockClose, onCancelEnd, cancellingEnd, onExtend, extending,
  showAddSecondRide, onAddSecondRide,
  showRideSwitcher, activeSlot = 1, onSelectSlot,
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
          <div
            className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest ${
              paused ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                paused ? "bg-amber-500" : "bg-green-500 ride-pulse"
              }`}
            />
            {paused ? "Пауза" : "В пути"}
          </div>
          <div className="font-display text-base font-light leading-tight tabular-nums" data-testid="text-ride-duration">
            <RideTimer ride={ride} />
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Овертайм</div>
          <div className="text-[9px] text-muted-foreground" data-testid="text-overage-rate">
            {OVERAGE_MINUTE_PRICE} рублей минута
          </div>
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

      {showRideSwitcher && (
        <div
          className="mt-2 h-11 flex rounded-xl border border-card-border bg-background/50 overflow-hidden"
          data-testid="ride-slot-switcher"
        >
          {([1, 2] as const).map((slot) => (
            <button
              key={slot}
              type="button"
              onClick={() => onSelectSlot?.(slot)}
              data-testid={`button-ride-slot-${slot}`}
              className={cn(
                "flex-1 flex items-center justify-center font-display text-base transition-colors hover-elevate active:scale-[0.98]",
                slot === 1 && "border-r border-card-border",
                activeSlot === slot ? "bg-primary text-black font-medium" : "text-muted-foreground font-light"
              )}
            >
              {slot}
            </button>
          ))}
        </div>
      )}

      <AwaitingLockCloseDialog
        open={awaitingLockClose || awaitingEndLockClose}
        mode={awaitingEndLockClose ? "end" : "pause"}
        onCancel={awaitingEndLockClose ? onCancelEnd : onResume}
        cancelling={awaitingEndLockClose ? cancellingEnd : resuming}
      />

      <div className={`mt-2 grid gap-2 ${showAddSecondRide ? "grid-cols-3" : "grid-cols-2"}`}>
        <button
          type="button"
          onClick={paused || awaitingLockClose ? onResume : onPause}
          disabled={pausing || resuming || awaitingEndLockClose}
          data-testid={paused ? "button-resume-ride" : "button-pause-ride"}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-muted min-h-11 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          {pausing || resuming ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : paused || awaitingLockClose ? null : (
            <Pause className="w-4 h-4" />
          )}
          {paused ? (
            <span className="flex items-baseline gap-1.5">
              <PauseGraceCountdown ride={ride} />
              <span>Продолжить</span>
            </span>
          ) : awaitingLockClose ? (
            "Отмена"
          ) : (
            "Пауза"
          )}
        </button>
        <button
          type="button"
          onClick={() => setExtendOpen(true)}
          disabled={extending || awaitingEndLockClose}
          data-testid="button-extend-ride"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-muted min-h-11 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          <PlusCircle className="w-4 h-4" /> Продлить
        </button>
        {showAddSecondRide && (
          <button
            type="button"
            onClick={onAddSecondRide}
            disabled={awaitingEndLockClose}
            data-testid="button-add-second-ride"
            className="inline-flex flex-col items-center justify-center gap-1 rounded-xl bg-muted min-h-11 py-2 px-1 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
          >
            <span className="relative inline-flex items-center justify-center w-5 h-4 shrink-0">
              <Bike className="w-3.5 h-3.5 absolute left-0 top-0 opacity-60" />
              <Bike className="w-3.5 h-3.5 absolute right-0 top-0.5" />
            </span>
            <span className="text-[10px] leading-tight text-center">Ещё один велосипед</span>
          </button>
        )}
      </div>

      <div className="mt-2">
        <button
          type="button"
          onClick={awaitingEndLockClose ? onCancelEnd : onEnd}
          disabled={ending || cancellingEnd}
          data-testid="button-end-ride"
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand-sand-deep text-brand-bark h-11 font-medium shadow-sm hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          {ending || cancellingEnd ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : awaitingEndLockClose ? (
            <X className="w-4 h-4" />
          ) : (
            <Lock className="w-4 h-4" />
          )}
          {awaitingEndLockClose ? "Отмена" : "Завершить поездку"}
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

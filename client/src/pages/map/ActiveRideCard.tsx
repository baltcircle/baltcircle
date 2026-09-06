import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { Lock, Pause, PlusCircle, Loader2, X, Bike } from "lucide-react";
import { PauseGraceCountdown } from "@/components/PauseGraceCountdown";
import type { Ride } from "@shared/schema";
import type { Tariff } from "@shared/geo";
import { RideTimer } from "@/components/RideTimer";
import { OveragePanel } from "@/components/OveragePanel";
import { ExtendRideDialog } from "@/components/ExtendRideDialog";
import { AwaitingLockCloseDialog } from "@/components/AwaitingLockCloseDialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  /** true when the rider has two simultaneous active rides — shows the slot switcher in the header. */
  showRideSwitcher?: boolean;
  /** which ride slot (1 or 2) this card is currently displaying. */
  activeSlot?: 1 | 2;
  onSelectSlot?: (slot: 1 | 2) => void;
  /** bike id to print on each switcher button, keyed by slot. */
  slotBikeIds?: Partial<Record<1 | 2, string>>;
  /**
   * Нажатие по свободной (некнопочной) области карточки — центрирует карту
   * на велосипеде этой поездки. Клики по кнопкам/диалогам сюда не попадают.
   */
  onFocusBike?: () => void;
}

// Элементы, клик по которым — самостоятельное действие, а не «нажатие на карточку».
const NON_FOCUS_SELECTOR =
  'button, a, input, select, textarea, label, [role="button"], [role="dialog"], [data-no-map-focus]';

export function ActiveRideCard({
  ride, onEnd, ending, onPause, onResume, pausing, resuming, awaitingLockClose,
  awaitingEndLockClose, onCancelEnd, cancellingEnd, onExtend, extending,
  showAddSecondRide, onAddSecondRide,
  showRideSwitcher, activeSlot = 1, onSelectSlot, slotBikeIds, onFocusBike,
}: ActiveRideCardProps) {
  const [extendOpen, setExtendOpen] = useState(false);
  const [confirmEndOpen, setConfirmEndOpen] = useState(false);
  const paused = ride.pausedAt != null;

  const handleCardClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onFocusBike) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(NON_FOCUS_SELECTOR)) return;
    // Не перехватываем выделение текста как нажатие.
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
    onFocusBike();
  };

  return (
    <div
      className="rounded-2xl bg-card/95 text-card-foreground backdrop-blur-sm shadow-xl px-5 py-4"
      data-testid="home-active-ride-card"
      onClick={handleCardClick}
    >
      <div className="flex justify-center">
        {showRideSwitcher ? (
          <div
            className="h-9 flex rounded-full border border-card-border bg-background/50 overflow-hidden"
            data-testid="ride-slot-switcher"
          >
            {([1, 2] as const).map((slot) => (
              <button
                key={slot}
                type="button"
                onClick={() => onSelectSlot?.(slot)}
                data-testid={`button-ride-slot-${slot}`}
                className={cn(
                  "px-4 flex items-center justify-center font-display text-sm transition-colors hover-elevate active:scale-[0.98]",
                  slot === 1 && "border-r border-card-border",
                  activeSlot === slot ? "bg-primary text-black font-medium" : "text-muted-foreground font-light"
                )}
              >
                {slotBikeIds?.[slot] ?? slot}
              </button>
            ))}
          </div>
        ) : (
          <div
            className="font-display text-lg font-medium tracking-wide text-brand-sea"
            data-testid="text-active-bike"
          >
            {ride.bikeId}
          </div>
        )}
      </div>

      <div className="mt-1 flex items-center justify-between gap-3">
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
        <OveragePanel ride={ride} />
      </div>

      <AwaitingLockCloseDialog
        open={awaitingLockClose || awaitingEndLockClose}
        mode={awaitingEndLockClose ? "end" : "pause"}
        onCancel={awaitingEndLockClose ? onCancelEnd : onResume}
        cancelling={awaitingEndLockClose ? cancellingEnd : resuming}
      />

      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={paused || awaitingLockClose ? onResume : onPause}
          disabled={pausing || resuming || awaitingEndLockClose}
          data-testid={paused ? "button-resume-ride" : "button-pause-ride"}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-muted min-h-11 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          {pausing || resuming ? (
            <Loader2 className="w-4 h-4 animate-spin text-brand-sea" />
          ) : paused || awaitingLockClose ? null : (
            <Pause className="w-4 h-4 text-brand-sea" />
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
          onClick={onAddSecondRide}
          disabled={!showAddSecondRide || awaitingEndLockClose}
          data-testid="button-add-second-ride"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-muted min-h-11 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          <span className="relative inline-flex items-center justify-center w-6 h-4 shrink-0">
            <Bike className="w-3.5 h-3.5 absolute left-0 top-0 text-brand-sea/60" />
            <Bike className="w-3.5 h-3.5 absolute right-0 top-0.5 text-brand-sea" />
          </span>
          Доп. велосипед
        </button>
      </div>

      <div className="mt-2">
        <button
          type="button"
          onClick={() => setExtendOpen(true)}
          disabled={extending || awaitingEndLockClose}
          data-testid="button-extend-ride"
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-muted h-11 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          <PlusCircle className="w-4 h-4 text-brand-sea" /> Продлить аренду
        </button>
      </div>

      <div className="mt-2">
        <button
          type="button"
          onClick={() => {
            if (awaitingEndLockClose) { onCancelEnd(); return; }
            if (paused) { setConfirmEndOpen(true); return; }
            onEnd();
          }}
          disabled={ending || cancellingEnd}
          data-testid="button-end-ride"
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-muted h-11 font-medium hover-elevate active:scale-[0.98] transition-transform disabled:opacity-50 disabled:pointer-events-none"
        >
          {ending || cancellingEnd ? (
            <Loader2 className="w-4 h-4 animate-spin text-brand-sea" />
          ) : awaitingEndLockClose ? (
            <X className="w-4 h-4 text-brand-sea" />
          ) : (
            <Lock className="w-4 h-4 text-brand-sea" />
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

      <AlertDialog open={confirmEndOpen} onOpenChange={setConfirmEndOpen}>
        <AlertDialogContent className="rounded-3xl" data-testid="dialog-confirm-end-ride">
          <AlertDialogHeader>
            <AlertDialogTitle>Завершить поездку?</AlertDialogTitle>
            <AlertDialogDescription>
              Замок уже закрыт, поездка на паузе. После завершения продолжить её будет нельзя — будет списана итоговая стоимость.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-confirm-end-ride">Отмена</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-end-ride"
              onClick={() => {
                setConfirmEndOpen(false);
                onEnd();
              }}
            >
              Завершить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

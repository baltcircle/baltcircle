import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CalendarClock, X, Loader2 } from "lucide-react";
import type { Reservation } from "@shared/schema";

/**
 * Тикающий обратный отсчёт до `expiresAt`. Изолирован в отдельный компонент —
 * тикает раз в секунду САМ (см. RideTimer.tsx), не перерисовывая MapPage.
 * Вызывает onExpire() один раз, когда время истекло, и после этого рендерит
 * null — родитель убирает баннер по следующему изменению кеша.
 */
function ReservationCountdown({ expiresAt, onExpire }: { expiresAt: number; onExpire: () => void }) {
  const [remainingMs, setRemainingMs] = useState(() => expiresAt - Date.now());

  useEffect(() => {
    const id = setInterval(() => setRemainingMs(expiresAt - Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  useEffect(() => {
    if (remainingMs <= 0) onExpire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingMs <= 0]);

  if (remainingMs <= 0) return null;
  const totalSeconds = Math.floor(remainingMs / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return <>{m}:{String(s).padStart(2, "0")}</>;
}

interface ReservationBannerProps {
  reservation: Reservation;
  onCancel: () => void;
  cancelling: boolean;
  onExpire: () => void;
  /**
   * Нажатие по баннеру — центрирует карту на забронированном велосипеде.
   * Кнопка отмены брони остаётся самостоятельным действием и фокус не вызывает.
   */
  onFocusBike?: () => void;
}

const NON_FOCUS_SELECTOR = 'button, a, input, [role="button"], [data-no-map-focus]';

export function ReservationBanner({ reservation, onCancel, cancelling, onExpire, onFocusBike }: ReservationBannerProps) {
  const handleBannerClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!onFocusBike) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(NON_FOCUS_SELECTOR)) return;
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
    onFocusBike();
  };

  return (
    <div
      className="rounded-2xl bg-card/95 text-card-foreground backdrop-blur-sm shadow-xl px-4 py-3"
      data-testid="home-reservation-banner"
      onClick={handleBannerClick}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-accent shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Бронь</div>
            <div className="font-display text-base font-light leading-tight truncate" data-testid="text-reservation-bike">
              {reservation.bikeId}
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Осталось</div>
          <div className="font-display text-base font-light tabular-nums" data-testid="text-reservation-countdown">
            <ReservationCountdown expiresAt={reservation.expiresAt} onExpire={onExpire} />
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          aria-label="Отменить бронь"
          data-testid="button-cancel-reservation"
          className="shrink-0 w-9 h-9 rounded-full bg-background/50 border border-card-border flex items-center justify-center hover:bg-black/10 transition-colors disabled:opacity-50"
        >
          {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";

import { liveRemainingPaidMs, liveOverageElapsedMs, type PausableRide } from "@shared/pause";
import { LiveOverage } from "@/components/LiveOverage";
import { OVERAGE_MINUTE_PRICE } from "@shared/geo";

/** Показываем блок овертайма только в последние N минут оплаченного времени. */
const OVERAGE_PREVIEW_WINDOW_MS = 5 * 60 * 1000;

/**
 * Блок овертайма на карточке активной аренды. Скрыт до тех пор, пока не
 * останется OVERAGE_PREVIEW_WINDOW_MS оплаченного времени (или пока не
 * начался сам овертайм) — не занимает место и не пугает цифрами раньше
 * времени. Тикает раз в секунду ВНУТРИ себя, чтобы решение показать/скрыть
 * блок не зависело от ре-рендеров родителя.
 */
export function OveragePanel({ ride }: { ride: PausableRide & { startedAt: number } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remainingMs = liveRemainingPaidMs(ride, now);
  const overageMs = liveOverageElapsedMs(ride, now);
  if (overageMs <= 0 && remainingMs > OVERAGE_PREVIEW_WINDOW_MS) return null;

  return (
    <div className="text-right shrink-0" data-testid="panel-ride-overage">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Овертайм</div>
      <div className="text-[9px] text-muted-foreground" data-testid="text-overage-rate">
        {OVERAGE_MINUTE_PRICE} рублей минута
      </div>
      <div className="font-display text-base font-light tabular-nums" data-testid="text-ride-overage">
        <LiveOverage ride={ride} />
      </div>
    </div>
  );
}

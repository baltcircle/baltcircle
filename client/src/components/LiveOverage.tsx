import { useEffect, useState } from "react";

import { liveOverageElapsedMs, type PausableRide } from "@shared/pause";

/** H:MM:SS (или MM:SS, если овертайм короче часа) — растущий секундомер. */
function fmtOverageTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Живой овертайм над оплаченным временем. Серый «0:00», пока в рамках
 * оплаченного окна; красный и тикающий секундомер (H:MM:SS), как только
 * начинается овертайм — считает с той же точки (effectivePaidUntilAt), что
 * и settlement на сервере (endRide/computeOverage), так итоговое списание
 * никогда не «расходится» с тем, что видел райдер. Тикает раз в секунду
 * ВНУТРИ себя, чтобы ре-рендерился только он (см. RideTimer / audit L1).
 */
export function LiveOverage({ ride }: { ride: PausableRide & { startedAt: number } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = liveOverageElapsedMs(ride, now);
  return (
    <span
      className={elapsedMs > 0 ? "text-destructive" : "text-muted-foreground"}
      data-testid="text-ride-overage"
    >
      {fmtOverageTimer(elapsedMs)}
    </span>
  );
}

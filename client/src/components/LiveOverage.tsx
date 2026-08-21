import { useEffect, useState } from "react";

import { fmtRub } from "@/lib/format";
import { computeLiveOverage, type PausableRide } from "@shared/pause";

/**
 * Живой овертайм над оплаченным временем. Серый «0 ₽», пока в рамках
 * оплаченного окна; красный и тикающий, как только начисляется овертайм —
 * та же формула, что settlement на сервере (endRide), так финальная
 * стоимость никогда не «прыгает» относительно того, что видел райдер.
 */
export function LiveOverage({ ride }: { ride: PausableRide & { startedAt: number } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const { overageKopecks } = computeLiveOverage(ride, now);
  return (
    <span
      className={overageKopecks > 0 ? "text-destructive" : "text-muted-foreground"}
      data-testid="text-ride-overage"
    >
      {overageKopecks > 0 ? `+${fmtRub(overageKopecks)}` : "0 ₽"}
    </span>
  );
}

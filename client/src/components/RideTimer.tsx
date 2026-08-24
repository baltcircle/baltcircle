import { useEffect, useState } from "react";

import { fmtDuration } from "@/lib/format";
import { liveRemainingPaidMs, type PausableRide } from "@shared/pause";

/**
 * "В пути" таймер активной поездки — обратный отсчёт: сколько оплаченного
 * времени осталось (напр. «1 ч 59 мин» → «1 ч 58 мин» ...). Как только
 * оплаченное время истекает, останавливается на 0 и в минус не уходит —
 * овертайм показывает отдельно LiveOverage. Тикает раз в секунду ВНУТРИ
 * себя, чтобы ре-рендерился только он, а не всё дерево MapPage (см. audit L1).
 *
 * Замирает во время паузы, пока не исчерпан суммарный бесплатный грейс
 * (shared/pause.ts), после чего тикает и во время паузы — единая формула с
 * сервером, чтобы при resume/end число не «прыгало».
 */
export function RideTimer({ ride }: { ride: PausableRide }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{fmtDuration(liveRemainingPaidMs(ride, now))}</>;
}

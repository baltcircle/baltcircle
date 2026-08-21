import { useEffect, useState } from "react";

import { fmtDuration } from "@/lib/format";
import { liveElapsedRidingMs, type PausableRide } from "@shared/pause";

/**
 * "В пути" таймер активной поездки. Тикает раз в секунду ВНУТРИ себя, чтобы
 * ре-рендерился только он, а не всё дерево MapPage (см. audit L1).
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
  return <>{fmtDuration(liveElapsedRidingMs(ride, now))}</>;
}

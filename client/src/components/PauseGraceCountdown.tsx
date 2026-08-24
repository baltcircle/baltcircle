import { useEffect, useState } from "react";

import { remainingFreeGraceMs, type PausableRide } from "@shared/pause";

/** MM:SS — compact on purpose, this renders inline inside a fixed-height button. */
function fmtMMSS(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Обратный отсчёт бесплатного грейса паузы (PAUSE_FREE_GRACE_MS, сейчас
 * 10 минут) — показывается внутри кнопки "Продолжить", пока велосипед
 * реально на паузе. Тикает раз в секунду сам по себе (см. RideTimer/
 * LiveOverage — тот же паттерн), замирает на 0, когда грейс исчерпан
 * (дальше просто идёт платный овертайм, отдельным индикатором).
 */
export function PauseGraceCountdown({ ride }: { ride: PausableRide }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = remainingFreeGraceMs(ride, now);
  return (
    <span className="tabular-nums" data-testid="text-pause-grace-countdown">
      {fmtMMSS(remaining)}
    </span>
  );
}

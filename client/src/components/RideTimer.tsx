import { useEffect, useState } from "react";

import { fmtDuration } from "@/lib/format";

/**
 * Таймер активной поездки. Тикает раз в секунду ВНУТРИ себя, чтобы
 * ре-рендерился только он, а не всё дерево MapPage (см. audit L1).
 */
export function RideTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{fmtDuration(now - startedAt)}</>;
}

import { useEffect, useState } from "react";

export function useClock(intervalMs = 1000, enabled = true) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    update();
    const timer = setInterval(update, intervalMs);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [intervalMs, enabled]);
  return now;
}

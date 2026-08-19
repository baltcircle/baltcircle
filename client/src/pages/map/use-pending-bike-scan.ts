import { useEffect, type MutableRefObject } from "react";
import type { Bike } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { PENDING_BIKE_KEY } from "@/lib/pending-bike";
import { INTRO_SHOWN_KEY } from "./map-constants";

interface UsePendingBikeScanParams {
  userLoading: boolean;
  isRegistered: boolean;
  bikes: Bike[] | undefined;
  pendingMulti: MutableRefObject<boolean | null>;
  setRegOpen: (open: boolean) => void;
  onBikeScanned: (bike: Bike) => void;
}

/**
 * Два независимых, но связанных с онбордингом эффекта:
 * 1) первый заход незарегистрированного юзера — один раз показываем интро-регистрацию;
 * 2) QR велосипеда, отсканированный до полной загрузки приложения (deep-link),
 *    ждёт в sessionStorage — подхватываем его как только список велосипедов загрузится.
 */
export function usePendingBikeScan({
  userLoading,
  isRegistered,
  bikes,
  pendingMulti,
  setRegOpen,
  onBikeScanned,
}: UsePendingBikeScanParams) {
  const toast = useToast();

  useEffect(() => {
    if (userLoading || isRegistered) return;
    if (localStorage.getItem(INTRO_SHOWN_KEY)) return;
    localStorage.setItem(INTRO_SHOWN_KEY, "1");
    setRegOpen(true);
  }, [userLoading, isRegistered, setRegOpen]);

  useEffect(() => {
    if (userLoading || !bikes) return;
    const code = sessionStorage.getItem(PENDING_BIKE_KEY);
    if (!code) return;
    sessionStorage.removeItem(PENDING_BIKE_KEY);

    const target = bikes.find((b) => b.id.toUpperCase() === code);
    if (!target) {
      toast.toast({ title: "Велосипед не найден", description: code, variant: "destructive" });
      return;
    }
    if (target.status !== "available") {
      toast.toast({ title: "Велосипед недоступен", description: `${target.id} сейчас занят`, variant: "destructive" });
      return;
    }
    if (!isRegistered) {
      pendingMulti.current = false;
      setRegOpen(true);
      return;
    }
    onBikeScanned(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLoading, bikes, isRegistered]);
}

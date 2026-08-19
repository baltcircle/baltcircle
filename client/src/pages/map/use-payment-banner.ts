import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PAYMENT_BANNER_KEY } from "./map-constants";

/**
 * Баннер «добавьте способ оплаты», показывается под кнопкой скан, если нет карты
 * и не закрыт в эту сессию (перенесён из бургер-меню).
 */
export function usePaymentBanner(isRegistered: boolean, hasActiveRide: boolean) {
  const methodsQ = useQuery<any[]>({
    queryKey: ["/api/payment-methods"],
    enabled: isRegistered,
  });
  const hasCard = (methodsQ.data?.length ?? 0) > 0;
  const [paymentBannerDismissed, setPaymentBannerDismissed] = useState(
    () => sessionStorage.getItem(PAYMENT_BANNER_KEY) === "1"
  );
  const dismissPaymentBanner = () => {
    sessionStorage.setItem(PAYMENT_BANNER_KEY, "1");
    setPaymentBannerDismissed(true);
  };
  // Не показываем баннер, пока способы оплаты ещё грузятся — иначе при reload
  // он мигает (hasCard=false до ответа, затем исчезает).
  const methodsReady = !methodsQ.isLoading && methodsQ.isFetched;
  const showPaymentBanner =
    isRegistered && methodsReady && !hasCard && !paymentBannerDismissed && !hasActiveRide;

  return { showPaymentBanner, dismissPaymentBanner };
}

import { Link } from "wouter";
import { CreditCard, QrCode, X } from "lucide-react";

interface ScanAndPaymentBannerProps {
  isRegistered: boolean;
  onScan: () => void;
  showPaymentBanner: boolean;
  onDismissBanner: () => void;
}

export function ScanAndPaymentBanner({
  isRegistered,
  onScan,
  showPaymentBanner,
  onDismissBanner,
}: ScanAndPaymentBannerProps) {
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onScan}
        aria-label={isRegistered ? "Сканировать QR" : "Сканировать QR (нужна регистрация)"}
        data-testid="home-primary-scan"
        className="w-full h-14 rounded-full bg-primary hover:opacity-90 text-black font-medium text-lg flex items-center justify-between px-6 shadow-lg active:scale-[0.98] transition-all"
      >
        <span>Сканировать</span>
        <QrCode className="w-6 h-6" />
      </button>

      {/* Payment banner — под кнопкой скан. Крестик скрывает баннер,
       * блок анкорится по нижнему краю — кнопка скан опускается на его место. */}
      {showPaymentBanner && (
        <div className="rounded-2xl bg-card/95 text-card-foreground backdrop-blur-sm shadow-xl px-4 py-3 relative">
          <button
            type="button"
            onClick={onDismissBanner}
            className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-full hover:bg-black/10 transition-colors"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4 text-card-foreground/70" />
          </button>
          <div className="flex items-start gap-3 pr-6">
            <CreditCard className="w-5 h-5 text-card-foreground/80 shrink-0 mt-0.5" />
            <p className="text-sm text-card-foreground leading-snug">
              Добавьте способ оплаты, чтобы начать кататься
            </p>
          </div>
          <Link
            href="/payment-methods"
            onClick={() => {
              // Зашли с баннера на главном экране — кнопка «назад»
              // должна вернуть на карту, а не в меню.
              try {
                sessionStorage.setItem("bc.pm.origin", "map");
              } catch {
                /* ignore */
              }
            }}
            className="mt-3 flex items-center justify-center w-full h-10 rounded-full bg-primary hover:opacity-90 text-black text-sm font-medium transition-colors"
          >
            Добавить оплату
          </Link>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { TEST_PAYMENT_QR_LOCAL, TEST_PAYMENT_QR_REMOTE } from "@/lib/payment";
import { CreditCard, Smartphone, ShieldCheck, QrCode, ExternalLink } from "lucide-react";

export function PaymentMethodsPage() {
  const toast = useToast();

  // MVP payment-method state — no real card data is collected or stored.
  const [method, setMethod] = useState<"card" | "sbp">("card");
  const [cardBound, setCardBound] = useState(false);
  const [sbpBound, setSbpBound] = useState(false);

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-2xl mx-auto" data-testid="page-payment-methods">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Оплата</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Способы оплаты</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-prose">
          Привяжите карту или СБП. Стоимость поездки спишется с выбранного способа оплаты — пополнять баланс не нужно.
        </p>
      </header>

      {/* Payment method card — card binding + SBP (MVP placeholders) */}
      <Card className="p-6" data-testid="card-payment-method">
        <div className="grid sm:grid-cols-2 gap-2 mb-4">
          <Button
            variant={method === "card" ? "default" : "outline"}
            onClick={() => setMethod("card")}
            data-testid="button-method-card"
          >
            <CreditCard className="w-4 h-4 mr-2" /> Карта
          </Button>
          <Button
            variant={method === "sbp" ? "default" : "outline"}
            onClick={() => setMethod("sbp")}
            data-testid="button-method-sbp"
          >
            <Smartphone className="w-4 h-4 mr-2" /> СБП
          </Button>
        </div>

        {method === "card" ? (
          <div className="space-y-3" data-testid="block-card">
            <div className="rounded-md bg-muted/60 p-3 text-sm flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-muted-foreground" />
              <span className="font-mono">{cardBound ? "•••• •••• •••• 4242" : "Карта не привязана"}</span>
              {cardBound && <span className="ml-auto text-xs text-muted-foreground">Visa · тест</span>}
            </div>
            <Button
              className="w-full"
              variant={cardBound ? "outline" : "default"}
              onClick={() => {
                setCardBound((v) => !v);
                toast.toast({
                  title: cardBound ? "Карта отвязана" : "Карта привязана (тест)",
                  description: cardBound ? undefined : "MVP-привязка. Данные карты не сохраняются.",
                });
              }}
              data-testid="button-bind-card"
            >
              {cardBound ? "Отвязать карту" : "Привязать карту"}
            </Button>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="w-3 h-3" /> MVP: номер карты и CVC не собираются. Реальное списание не выполняется.
            </div>
          </div>
        ) : (
          <div className="space-y-3" data-testid="block-sbp">
            <div className="text-sm font-medium flex items-center gap-1.5">
              <QrCode className="w-4 h-4 text-muted-foreground" /> Оплата по СБП (тест)
            </div>
            <a
              href={TEST_PAYMENT_QR_REMOTE}
              target="_blank"
              rel="noopener noreferrer"
              className="block mx-auto w-44"
              data-testid="link-test-qr"
            >
              <img
                src={TEST_PAYMENT_QR_LOCAL}
                alt="QR для оплаты по СБП"
                className="w-44 h-auto rounded-md border border-card-border bg-white"
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = TEST_PAYMENT_QR_REMOTE; }}
              />
            </a>
            <Button
              className="w-full"
              variant={sbpBound ? "outline" : "default"}
              onClick={() => {
                setSbpBound((v) => !v);
                toast.toast({
                  title: sbpBound ? "СБП отключён" : "СБП подключён (тест)",
                  description: sbpBound ? undefined : "MVP-подключение. Реальная оплата не производится.",
                });
              }}
              data-testid="button-sbp-payment"
            >
              {sbpBound ? "Отключить СБП" : "Подключить СБП"}
            </Button>
            <Button asChild variant="outline" className="w-full" data-testid="button-open-payment">
              <a href={TEST_PAYMENT_QR_REMOTE} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4 mr-2" /> Открыть тестовую оплату
              </a>
            </Button>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="w-3 h-3" /> MVP: тестовый QR для СБП. Подтверждение выполняется вручную.
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

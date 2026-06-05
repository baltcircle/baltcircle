import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { TARIFFS } from "@shared/geo";
import type { Tariff } from "@shared/geo";
import { TEST_PAYMENT_QR_LOCAL, TEST_PAYMENT_QR_REMOTE } from "@/lib/payment";
import { CreditCard, Check, Smartphone, ShieldCheck, QrCode, ExternalLink } from "lucide-react";

export function TariffsPage() {
  const toast = useToast();

  // Selected tariff is a local UI preference for the upcoming ride. There is no
  // wallet balance and no top-up — charges go to the linked card/SBP after a ride.
  const [selectedTariff, setSelectedTariff] = useState<Tariff["id"]>("payg");
  const [method, setMethod] = useState<"card" | "sbp">("card");
  const [cardBound, setCardBound] = useState(false);
  const [sbpBound, setSbpBound] = useState(false);

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-6xl mx-auto" data-testid="page-tariffs">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Тарифы и оплата</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Платите как удобно</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-prose">
          Выберите тариф и привяжите карту или СБП. Стоимость поездки спишется с выбранного способа оплаты — пополнять баланс не нужно.
        </p>
      </header>

      {/* Payment method card — card binding + SBP (MVP placeholders) */}
      <Card className="p-6 mb-8" data-testid="card-payment-method">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Способ оплаты</div>
        <div className="font-display text-xl font-light mt-1 mb-4">Привяжите карту или СБП</div>

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

      {/* Tariff plans */}
      <div className="grid md:grid-cols-3 gap-4 mb-4">
        {TARIFFS.map((t) => {
          const isActive = selectedTariff === t.id;
          return (
            <Card
              key={t.id}
              className={`p-6 relative overflow-hidden ${t.popular ? "border-primary/40 ring-1 ring-primary/30" : ""}`}
              data-testid={`card-tariff-${t.id}`}
            >
              {t.popular && (
                <Badge className="absolute top-4 right-4 bg-accent text-accent-foreground border-0">Популярный</Badge>
              )}
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
                {t.id === "payg" ? "Поминутно" : t.id === "day" ? "Сутки" : "Месяц"}
              </div>
              <div className="font-display text-2xl font-light mt-1">{t.name}</div>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="font-display text-4xl font-light">{t.price}</span>
                <span className="text-muted-foreground text-sm">{t.unit}</span>
              </div>
              <p className="text-sm text-muted-foreground mt-3 leading-relaxed">{t.description}</p>
              <Button
                className="mt-5 w-full"
                variant={isActive ? "outline" : "default"}
                disabled={isActive}
                onClick={() => {
                  setSelectedTariff(t.id);
                  toast.toast({ title: "Тариф выбран", description: `${t.name}. Спишется с привязанного способа оплаты.` });
                }}
                data-testid={`button-select-${t.id}`}
              >
                {isActive ? <><Check className="w-4 h-4 mr-2" />Выбран</> : t.id === "payg" ? "Выбрать режим" : "Выбрать"}
              </Button>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground max-w-prose" data-testid="text-charge-note">
        Списание производится автоматически после завершения поездки с привязанной карты или по СБП. Внутреннего баланса нет.
      </p>
    </div>
  );
}

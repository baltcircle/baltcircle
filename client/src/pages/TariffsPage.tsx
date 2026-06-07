import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { TARIFFS } from "@shared/geo";
import type { Tariff } from "@shared/geo";
import { Check } from "lucide-react";

export function TariffsPage() {
  const toast = useToast();

  // Selected tariff is a local UI preference for the upcoming ride. Charges go
  // to the linked card/SBP (configured in «Способы оплаты») after a ride.
  const [selectedTariff, setSelectedTariff] = useState<Tariff["id"]>("h1");

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-6xl mx-auto" data-testid="page-tariffs">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Тарифы</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Выберите тариф</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-prose">
          Стоимость поездки спишется с привязанного способа оплаты — пополнять баланс не нужно.
        </p>
      </header>

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
              <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Аренда</div>
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
                {isActive ? <><Check className="w-4 h-4 mr-2" />Выбран</> : "Выбрать"}
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

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PaymentMethod } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmtDate } from "@/lib/format";
import { TEST_PAYMENT_QR_LOCAL, TEST_PAYMENT_QR_REMOTE } from "@/lib/payment";
import { CreditCard, Smartphone, ShieldCheck, QrCode, ExternalLink, Trash2 } from "lucide-react";

const METHODS_KEY = ["/api/payment-methods"];

export function PaymentMethodsPage() {
  const toast = useToast();

  // MVP payment-method state — no real card data is collected or stored. The
  // linked methods themselves persist per user via the backend.
  const [method, setMethod] = useState<"card" | "sbp">("card");

  const methodsQ = useQuery<PaymentMethod[]>({ queryKey: METHODS_KEY });
  const methods = methodsQ.data ?? [];
  const hasCard = methods.some((m) => m.type === "card");
  const hasSbp = methods.some((m) => m.type === "sbp");

  const linkMut = useMutation({
    mutationFn: async (type: "card" | "sbp") => {
      const res = await apiRequest("POST", "/api/payment-methods", { type });
      return res.json();
    },
    onSuccess: (_d, type) => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      toast.toast({
        title: type === "card" ? "Карта привязана (тест)" : "СБП подключён (тест)",
        description: "MVP-привязка. Данные карты не сохраняются, списание не выполняется.",
      });
    },
    onError: (e: Error) => toast.toast({ title: "Не удалось привязать", description: cleanErr(e), variant: "destructive" }),
  });

  const unlinkMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/payment-methods/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      toast.toast({ title: "Способ оплаты отвязан" });
    },
    onError: (e: Error) => toast.toast({ title: "Не удалось отвязать", description: cleanErr(e), variant: "destructive" }),
  });

  const busy = linkMut.isPending || unlinkMut.isPending;

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-2xl mx-auto" data-testid="page-payment-methods">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Оплата</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Способы оплаты</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-prose">
          Привяжите карту или СБП. Стоимость поездки спишется с выбранного способа оплаты — пополнять баланс не нужно.
        </p>
      </header>

      {/* Linked methods (persisted per user) */}
      <Card className="p-6 mb-5" data-testid="card-linked-methods">
        <div className="text-sm font-medium mb-3">Привязанные способы</div>
        {methodsQ.isLoading ? (
          <div className="text-sm text-muted-foreground" data-testid="methods-loading">Загрузка…</div>
        ) : methods.length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="methods-empty">
            Пока нет привязанных способов оплаты.
          </div>
        ) : (
          <ul className="space-y-2" data-testid="methods-list">
            {methods.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-3 rounded-md bg-muted/60 p-3 text-sm"
                data-testid={`method-row-${m.id}`}
              >
                {m.type === "card" ? <CreditCard className="w-4 h-4 text-muted-foreground" /> : <Smartphone className="w-4 h-4 text-muted-foreground" />}
                <span className="font-mono">{m.label}</span>
                <span className="text-xs text-muted-foreground">{m.type === "card" ? "Visa · тест" : "СБП · тест"}</span>
                <span className="ml-auto text-xs text-muted-foreground">{fmtDate(m.createdAt)}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => unlinkMut.mutate(m.id)}
                  data-testid={`button-unlink-${m.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Add a payment method — card binding + SBP (MVP placeholders) */}
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
              <span className="font-mono">{hasCard ? "•••• •••• •••• 4242" : "Карта не привязана"}</span>
              {hasCard && <span className="ml-auto text-xs text-muted-foreground">Visa · тест</span>}
            </div>
            <Button
              className="w-full"
              disabled={busy || hasCard}
              onClick={() => linkMut.mutate("card")}
              data-testid="button-bind-card"
            >
              {hasCard ? "Карта уже привязана" : "Привязать карту"}
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
              disabled={busy || hasSbp}
              onClick={() => linkMut.mutate("sbp")}
              data-testid="button-sbp-payment"
            >
              {hasSbp ? "СБП уже подключён" : "Подключить СБП"}
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

// apiRequest throws "<status>: <body>" — pull a human message out of the body.
function cleanErr(e: Error): string {
  const m = e.message.match(/^\d+:\s*([\s\S]*)$/);
  const body = m ? m[1] : e.message;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) return parsed.error;
  } catch {
    // body wasn't JSON; fall through
  }
  return body;
}

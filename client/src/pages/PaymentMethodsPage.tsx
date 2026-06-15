import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PaymentMethod } from "@shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { fmtDate } from "@/lib/format";
import { TBANK_CONFIG_KEY, type TbankConfigResponse } from "@/lib/payment";
import {
  CreditCard, Smartphone, ShieldCheck, Loader2, ExternalLink, Trash2, Clock, AlertCircle,
} from "lucide-react";

const METHODS_KEY = ["/api/payment-methods"];

// Human label + tone for a payment-method status badge.
function statusLabel(status: string): { text: string; cls: string } {
  switch (status) {
    case "active":
      return { text: "Активна", cls: "text-primary" };
    case "pending":
      return { text: "Привязывается…", cls: "text-amber-600" };
    case "failed":
      return { text: "Ошибка привязки", cls: "text-destructive" };
    default:
      return { text: "Привязана", cls: "text-muted-foreground" };
  }
}

export function PaymentMethodsPage() {
  const toast = useToast();
  const { isRegistered, isLoading: userLoading } = useCurrentUser();
  const [redirecting, setRedirecting] = useState(false);

  const methodsQ = useQuery<PaymentMethod[]>({ queryKey: METHODS_KEY });
  const methods = methodsQ.data ?? [];

  // Probe whether real T-Bank acquiring is configured. When it is not, we show a
  // "Платежи настраиваются" notice instead of offering a flow that would 503.
  const cfgQ = useQuery<TbankConfigResponse>({ queryKey: TBANK_CONFIG_KEY });
  const tbankConfigured = cfgQ.data?.configured === true;

  const hasActiveOrPendingCard = methods.some(
    (m) => m.type === "card" && (m.status === "active" || m.status === "pending"),
  );

  // Start a real T-Bank card binding: the backend calls AddCard and returns a
  // PaymentURL we redirect to. Card data is entered only on T-Bank's form.
  const addCardMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/payments/tbank/add-card");
      return (await res.json()) as { paymentUrl: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      if (data.paymentUrl) {
        setRedirecting(true);
        window.location.href = data.paymentUrl;
      }
    },
    onError: (e: Error) =>
      toast.toast({ title: "Не удалось привязать карту", description: cleanErr(e), variant: "destructive" }),
  });

  const unlinkMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/payment-methods/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      toast.toast({ title: "Способ оплаты отвязан" });
    },
    onError: (e: Error) =>
      toast.toast({ title: "Не удалось отвязать", description: cleanErr(e), variant: "destructive" }),
  });

  const busy = addCardMut.isPending || unlinkMut.isPending || redirecting;

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-2xl mx-auto" data-testid="page-payment-methods">
      <header className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Оплата</div>
        <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Способы оплаты</h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-prose">
          Привяжите банковскую карту через защищённую форму T-Bank. Данные карты вводятся только на
          стороне банка — мы их не видим и не храним.
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
            {methods.map((m) => {
              const st = statusLabel(m.status);
              return (
                <li
                  key={m.id}
                  className="flex items-center gap-3 rounded-md bg-muted/60 p-3 text-sm"
                  data-testid={`method-row-${m.id}`}
                >
                  {m.type === "card" ? (
                    <CreditCard className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <Smartphone className="w-4 h-4 text-muted-foreground" />
                  )}
                  <span className="font-mono">{m.label}</span>
                  <span className={`text-xs flex items-center gap-1 ${st.cls}`}>
                    {m.status === "pending" && <Clock className="w-3 h-3" />}
                    {st.text}
                  </span>
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
              );
            })}
          </ul>
        )}
      </Card>

      {/* Add a card via T-Bank */}
      <Card className="p-6" data-testid="card-payment-method">
        <div className="text-sm font-medium flex items-center gap-1.5 mb-3">
          <CreditCard className="w-4 h-4 text-muted-foreground" /> Банковская карта
        </div>

        {userLoading || cfgQ.isLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-1.5" data-testid="tbank-loading">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Загрузка…
          </div>
        ) : !tbankConfigured ? (
          <div
            className="rounded-md bg-muted/60 p-3 text-sm flex items-start gap-2"
            data-testid="tbank-unconfigured"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
            <span>Платежи настраиваются. Привязка карты будет доступна позже.</span>
          </div>
        ) : !isRegistered ? (
          <div
            className="rounded-md bg-muted/60 p-3 text-sm flex items-start gap-2"
            data-testid="tbank-need-register"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
            <span>Войдите в аккаунт, чтобы привязать карту.</span>
          </div>
        ) : (
          <div className="space-y-3" data-testid="block-card">
            <Button
              className="w-full"
              disabled={busy || hasActiveOrPendingCard}
              onClick={() => addCardMut.mutate()}
              data-testid="button-bind-card"
            >
              {redirecting || addCardMut.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Открываем форму банка…</>
              ) : hasActiveOrPendingCard ? (
                "Карта уже привязана"
              ) : (
                <><ExternalLink className="w-4 h-4 mr-2" /> Привязать карту</>
              )}
            </Button>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="w-3 h-3" /> Номер карты и CVC вводятся на защищённой форме T-Bank.
              Мы храним только маскированный номер и статус.
            </div>
          </div>
        )}
      </Card>

      {/* SBP is planned but not yet implemented as real acquiring. */}
      <Card className="p-6 mt-5 opacity-70" data-testid="card-sbp-soon">
        <div className="text-sm font-medium flex items-center gap-1.5">
          <Smartphone className="w-4 h-4 text-muted-foreground" /> СБП
        </div>
        <div className="text-xs text-muted-foreground mt-2">
          Оплата по СБП появится позже.
        </div>
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

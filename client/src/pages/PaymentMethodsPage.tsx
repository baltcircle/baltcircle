import { useEffect, useRef, useState } from "react";
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
  RefreshCw,
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

  // Re-check a pending/failed binding by polling T-Bank GetAddCardState on the
  // server. Resolves a method stuck on "привязывается…" when the notification
  // webhook never arrived.
  const refreshMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/payment-methods/${id}/refresh`);
      return (await res.json()) as PaymentMethod;
    },
    onSuccess: (m) => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      if (m.status === "active") toast.toast({ title: "Карта привязана" });
      else if (m.status === "failed")
        toast.toast({ title: "Привязка не удалась", description: methodError(m), variant: "destructive" });
      else toast.toast({ title: "Привязка ещё выполняется", description: "Статус пока не изменился." });
    },
    onError: (e: Error) =>
      toast.toast({ title: "Не удалось проверить статус", description: cleanErr(e), variant: "destructive" }),
  });

  // When T-Bank redirects the rider back to /payment-methods after the hosted
  // form, the Success/Fail URL may carry Success / RequestKey / ErrorCode query
  // params. We don't trust these for state changes (the notification webhook is
  // authoritative), but we trigger a server-side refresh of the matching pending
  // method so the rider sees the resolved status without waiting, and surface a
  // failure message immediately. Runs once per unique query string.
  const handledRedirect = useRef<string>("");
  useEffect(() => {
    const search = window.location.search;
    if (!search || handledRedirect.current === search) return;
    const params = new URLSearchParams(search);
    if (!params.has("Success") && !params.has("RequestKey") && !params.has("ErrorCode")) return;
    handledRedirect.current = search;

    const ok = (params.get("Success") || "").toLowerCase() === "true";
    if (!ok) {
      const code = params.get("ErrorCode");
      toast.toast({
        title: "Не удалось привязать карту",
        description: code && code !== "0" ? `Банк вернул код ${code}.` : "Привязка карты была отклонена.",
        variant: "destructive",
      });
    }
    // Refresh the method matching the returned RequestKey (or the latest pending
    // one) to pull the authoritative status from T-Bank.
    const reqKey = params.get("RequestKey");
    const target = reqKey
      ? methods.find((m) => m.requestKey === reqKey)
      : methods.find((m) => m.type === "card" && m.status === "pending");
    if (target) refreshMut.mutate(target.id);

    // Strip the query params so a manual reload doesn't re-trigger.
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods]);

  const busy = addCardMut.isPending || unlinkMut.isPending || refreshMut.isPending || redirecting;

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
              const canRefresh = m.provider === "tbank" && !!m.requestKey && m.status !== "active";
              const err = methodError(m);
              return (
                <li
                  key={m.id}
                  className="rounded-md bg-muted/60 p-3 text-sm"
                  data-testid={`method-row-${m.id}`}
                >
                  <div className="flex items-center gap-3">
                    {m.type === "card" ? (
                      <CreditCard className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <Smartphone className="w-4 h-4 text-muted-foreground" />
                    )}
                    <span className="font-mono">{m.label}</span>
                    <span className={`text-xs flex items-center gap-1 ${st.cls}`}>
                      {m.status === "pending" && <Clock className="w-3 h-3" />}
                      {m.status === "failed" && <AlertCircle className="w-3 h-3" />}
                      {st.text}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">{fmtDate(m.createdAt)}</span>
                    {canRefresh && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => refreshMut.mutate(m.id)}
                        data-testid={`button-refresh-${m.id}`}
                        title="Проверить статус"
                      >
                        {refreshMut.isPending && refreshMut.variables === m.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => unlinkMut.mutate(m.id)}
                      data-testid={`button-unlink-${m.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  {m.status === "failed" && err && (
                    <div
                      className="mt-2 text-xs text-destructive flex items-start gap-1.5"
                      data-testid={`method-error-${m.id}`}
                    >
                      <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                      <span>{err}</span>
                    </div>
                  )}
                  {m.status === "pending" && (
                    <div className="mt-2 text-xs text-muted-foreground" data-testid={`method-pending-hint-${m.id}`}>
                      Если форма банка уже закрыта, нажмите «Проверить статус».
                    </div>
                  )}
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

// Render the stored T-Bank binding error for a failed method. Combines the
// acquirer's message/details with a parenthetical code when present; these
// fields come straight from T-Bank and carry no secret.
function methodError(m: PaymentMethod): string {
  const message = (m.lastErrorMessage || "").trim();
  const details = (m.lastErrorDetails || "").trim();
  const code = (m.lastErrorCode || "").trim();
  const base = message || details || "Банк отклонил привязку карты.";
  const extras = [
    code ? `код ${code}` : "",
    details && details !== base ? details : "",
  ].filter(Boolean).join(", ");
  return extras ? `${base} (${extras})` : base;
}

// apiRequest throws "<status>: <body>" — pull a human message out of the body.
// The add-card endpoint returns the acquirer's own { error, code, message,
// details }; surface the message plus a parenthetical code/details so a rider
// (or support) sees *why* the binding failed instead of a generic rejection.
function cleanErr(e: Error): string {
  const m = e.message.match(/^\d+:\s*([\s\S]*)$/);
  const body = m ? m[1] : e.message;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) {
      const extra = parsed.code ? `код ${parsed.code}` : "";
      const detail = parsed.details && parsed.details !== parsed.error ? parsed.details : "";
      const suffix = [extra, detail].filter(Boolean).join(", ");
      return suffix ? `${parsed.error} (${suffix})` : parsed.error;
    }
  } catch {
    // body wasn't JSON; fall through
  }
  return body;
}

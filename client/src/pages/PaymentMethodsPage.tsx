import { useEffect, useRef, useState } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PaymentMethod } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { fmtDate } from "@/lib/format";
import { TBANK_CONFIG_KEY, type TbankConfigResponse } from "@/lib/payment";
import {
  CreditCard, Loader2, Trash2, AlertCircle, RefreshCw, Plus,
} from "lucide-react";
import { CardBrandIcon, SbpBrandIcon } from "@/components/PaymentBrandIcon";

const METHODS_KEY = ["/api/payment-methods"];

// Human sublabel + tone for a payment-method status. Shown as the small
// secondary line under the method label, matching the profile-row style.
function statusLabel(status: string): { text: string; cls: string } {
  switch (status) {
    case "active":
      return { text: "Активна", cls: "text-green-500" };
    case "pending":
      return { text: "Привязывается…", cls: "text-amber-500" };
    case "failed":
      return { text: "Ошибка привязки", cls: "text-red-500" };
    default:
      return { text: "Привязана", cls: "text-gray-400 dark:text-zinc-500" };
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

  // Start a real T-Bank card binding via a small verification PAYMENT
  // (Init + Recurrent=Y): the backend creates the payment and returns a
  // PaymentURL we redirect to. The rider pays a tiny amount (e.g. 1 ₽) on
  // T-Bank's hosted form — card data never reaches us — and the resulting
  // RebillId lets us charge rides later. This is more reliable than AddCard on
  // test/sandbox terminals, which reject cards even with documented test cards.
  const bindCardMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/payments/tbank/bind-card-payment");
      return (await res.json()) as { paymentUrl: string; amountKopecks?: number };
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

  // Re-check a pending Init-bind method (the primary bind-card-payment flow) by
  // polling T-Bank GetState via its stored PaymentId. These rows have no
  // RequestKey, so the AddCard /refresh above can't resolve them — this is the
  // recovery path when the notification webhook never arrived.
  const refreshBindMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("GET", `/api/payments/tbank/refresh-bind/${id}`);
      return (await res.json()) as PaymentMethod;
    },
    onSuccess: (m) => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      if (m.status === "active") toast.toast({ title: "Карта привязана" });
      else if (m.status === "failed")
        toast.toast({ title: "Привязка не удалась", description: methodError(m), variant: "destructive" });
    },
  });

  // Auto-reconcile pending Init-bind methods. When the rider lands back on this
  // page (or it's open while a binding is in flight) we poll GetState every 2s
  // for up to ~30s so a missed webhook still resolves the card without a manual
  // reload. Stops as soon as no pending Init-bind method remains.
  useEffect(() => {
    const pending = methods.filter(
      (m) => m.provider === "tbank" && m.status === "pending" && !m.requestKey && !!m.paymentId,
    );
    if (pending.length === 0) return;
    let tries = 0;
    let cancelled = false;
    const tick = async () => {
      await Promise.all(
        pending.map((m) =>
          apiRequest("GET", `/api/payments/tbank/refresh-bind/${m.id}`).catch(() => undefined),
        ),
      );
      if (!cancelled) queryClient.invalidateQueries({ queryKey: METHODS_KEY });
    };
    const interval = setInterval(() => {
      if (++tries >= 15) {
        clearInterval(interval);
        return;
      }
      void tick();
    }, 2000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods]);

  // When T-Bank redirects the rider back to /payment-methods after the hosted
  // form, the Success/Fail URL may carry Success / RequestKey / ErrorCode query
  // params. We don't trust these for state changes (the notification webhook is
  // authoritative), but we surface a failure message immediately and reconcile
  // the pending method:
  //   • AddCard rows (have a RequestKey) → poll GetAddCardState via /refresh.
  //   • Init verification-payment rows (no RequestKey) → the webhook activates
  //     them; we just re-fetch the methods list a few times so the rider sees
  //     the webhook-updated status without a manual reload.
  // Runs once per unique query string.
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
    // Refresh the method matching the returned RequestKey to pull the
    // authoritative AddCard status from T-Bank.
    const reqKey = params.get("RequestKey");
    const refreshable = reqKey ? methods.find((m) => m.requestKey === reqKey) : undefined;
    if (refreshable) {
      refreshMut.mutate(refreshable.id);
    } else {
      // Init binding (or unknown): re-fetch the list a few times so the
      // webhook-driven status update shows up shortly after the redirect.
      let tries = 0;
      const poll = () => {
        queryClient.invalidateQueries({ queryKey: METHODS_KEY });
        if (++tries < 5) setTimeout(poll, 2000);
      };
      poll();
    }

    // Strip the query params so a manual reload doesn't re-trigger.
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods]);

  const busy =
    bindCardMut.isPending ||
    unlinkMut.isPending ||
    refreshMut.isPending ||
    refreshBindMut.isPending ||
    redirecting;

  // Guard the "Add card" action: don't offer the flow when acquiring isn't
  // configured, the rider isn't registered, or a request is in flight. Multiple
  // cards ARE allowed — no "already linked" short-circuit.
  const handleAddCard = () => {
    if (userLoading || cfgQ.isLoading) return;
    if (!tbankConfigured) {
      toast.toast({
        title: "Платежи настраиваются",
        description: "Привязка карты будет доступна позже.",
      });
      return;
    }
    if (!isRegistered) {
      toast.toast({
        title: "Нужен вход в аккаунт",
        description: "Войдите, чтобы привязать карту.",
      });
      return;
    }
    bindCardMut.mutate();
  };

  // SBP acquiring isn't wired up yet — surface an honest "coming later" notice
  // rather than fabricating a linked account row.
  const handleAddSbp = () => {
    toast.toast({
      title: "СБП скоро",
      description: "Оплата по СБП появится позже.",
    });
  };

  const cardBusy = redirecting || bindCardMut.isPending;

  return (
    <OverlayShell title="Способы оплаты">
      <div className="px-4 py-6 max-w-md mx-auto" data-testid="page-payment-methods">
        <header className="mb-5">
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Оплата</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Способы оплаты</h1>
        </header>

        {/* Linked methods — profile-style rows */}
        <div
          className="rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-800"
          data-testid="card-linked-methods"
        >
          {methodsQ.isLoading ? (
            <div className="px-4 py-4 text-sm text-muted-foreground" data-testid="methods-loading">
              Загрузка…
            </div>
          ) : methods.length === 0 ? (
            <div className="px-4 py-4 text-sm text-muted-foreground" data-testid="methods-empty">
              Пока нет привязанных способов оплаты.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-zinc-700" data-testid="methods-list">
              {methods.map((m) => {
                const st = statusLabel(m.status);
                const canRefresh = m.provider === "tbank" && !!m.requestKey && m.status !== "active";
                // Init-bind rows (the primary flow) have a PaymentId but no
                // RequestKey — they're re-checked via GetState (/refresh-bind).
                const canRefreshBind =
                  m.provider === "tbank" && !m.requestKey && !!m.paymentId && m.status !== "active";
                const err = methodError(m);
                const rowRefreshing =
                  (refreshMut.isPending && refreshMut.variables === m.id) ||
                  (refreshBindMut.isPending && refreshBindMut.variables === m.id);
                return (
                  <li
                    key={m.id}
                    className="px-4 py-3"
                    data-testid={`method-row-${m.id}`}
                  >
                    <div className="flex items-center gap-3">
                      {m.type === "card" ? (
                        <CardBrandIcon brand={m.brand as any} />
                      ) : (
                        <SbpBrandIcon />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-base font-semibold text-gray-900 dark:text-white truncate font-mono">
                          {m.label}
                        </p>
                        <p className="text-xs mt-0.5">
                          <span className={st.cls}>{st.text}</span>
                          <span className="text-gray-400 dark:text-zinc-500"> · {fmtDate(m.createdAt)}</span>
                        </p>
                      </div>
                      {(canRefresh || canRefreshBind) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => (canRefresh ? refreshMut.mutate(m.id) : refreshBindMut.mutate(m.id))}
                          data-testid={`button-refresh-${m.id}`}
                          title="Проверить статус"
                          className="flex items-center justify-center w-9 h-9 rounded-full text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 shrink-0"
                        >
                          {rowRefreshing ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RefreshCw className="w-4 h-4" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => unlinkMut.mutate(m.id)}
                        data-testid={`button-unlink-${m.id}`}
                        title="Отвязать"
                        className="flex items-center justify-center w-9 h-9 rounded-full text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    {m.status === "failed" && err && (
                      <div
                        className="mt-2 text-xs text-red-500 flex items-start gap-1.5"
                        data-testid={`method-error-${m.id}`}
                      >
                        <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>{err}</span>
                      </div>
                    )}
                    {m.status === "pending" && (
                      <div
                        className="mt-2 text-xs text-gray-400 dark:text-zinc-500"
                        data-testid={`method-pending-hint-${m.id}`}
                      >
                        {canRefresh || canRefreshBind
                          ? "Если форма банка уже закрыта, нажмите «Проверить статус»."
                          : "Статус обновится автоматически после подтверждения платежа банком."}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Add actions — profile-style rows */}
        <div className="mt-4 rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-800">
          <button
            type="button"
            disabled={busy}
            onClick={handleAddCard}
            data-testid="button-bind-card"
            className="w-full px-4 py-3 border-b border-gray-100 dark:border-zinc-700 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left"
          >
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
              {cardBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <CreditCard className="w-5 h-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-gray-900 dark:text-white">
                {methods.some((m) => m.type === "card" && (m.status === "active" || m.status === "pending"))
                  ? "Добавить ещё карту"
                  : "Добавить карту"}
              </p>
              <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">
                {cardBusy ? "Открываем форму банка…" : "Через защищённую форму T-Bank"}
              </p>
            </div>
            {!cardBusy && (
              <Plus className="w-5 h-5 text-gray-400 dark:text-zinc-500 shrink-0" />
            )}
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={handleAddSbp}
            data-testid="button-add-sbp"
            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors disabled:opacity-50 text-left"
          >
            <SbpBrandIcon />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-gray-900 dark:text-white">Добавить счёт СБП</p>
              <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Оплата по СБП появится позже</p>
            </div>
            <Plus className="w-5 h-5 text-gray-400 dark:text-zinc-500 shrink-0" />
          </button>
        </div>
      </div>
    </OverlayShell>
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

import { useEffect, useState } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PaymentMethod } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { fmtDate } from "@/lib/format";
import { TBANK_CONFIG_KEY, type TbankConfigResponse } from "@/lib/payment";
import {
  CreditCard, Loader2, Trash2, AlertCircle, RefreshCw, Plus, X, ExternalLink, CheckCircle2,
} from "lucide-react";
import { CardBrandIcon, SbpBrandIcon } from "@/components/PaymentBrandIcon";
import { BikeQr } from "@/components/BikeQr";

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

// Live state for an in-progress SBP account binding. `payload` is the QR/
// deeplink the rider opens in their bank; `methodId` is the pending row we poll
// to detect activation. `status` drives the modal's headline (waiting → success
// / failed). Held in component state so the QR modal survives re-renders while
// the rider authorises the binding in their bank app.
interface SbpBinding {
  methodId: number;
  payload: string;
  status: "waiting" | "active" | "failed";
  error?: string;
}

export function PaymentMethodsPage() {
  const toast = useToast();
  const { isRegistered, isLoading: userLoading } = useCurrentUser();
  const [redirecting, setRedirecting] = useState(false);
  const [sbpBinding, setSbpBinding] = useState<SbpBinding | null>(null);
  // Модальный iframe привязки карты: url — hosted-форма T-Bank, methodId — созданная
  // pending-запись для polling. null — модалка закрыта.
  const [tbankBind, setTbankBind] = useState<{ methodId: number; url: string } | null>(null);

  const methodsQ = useQuery<PaymentMethod[]>({ queryKey: METHODS_KEY });
  const methods = methodsQ.data ?? [];

  // Probe whether real T-Bank acquiring is configured. When it is not, we show a
  // "Платежи настраиваются" notice instead of offering a flow that would 503.
  const cfgQ = useQuery<TbankConfigResponse>({ queryKey: TBANK_CONFIG_KEY });
  const tbankConfigured = cfgQ.data?.configured === true;

  // Start a real T-Bank card binding via a small verification PAYMENT
  // The backend picks the binding method from config (TBANK_CARD_BIND_METHOD):
  // either a no-charge AddCard binding or a tiny (e.g. 1 ₽) Init+Recurrent
  // verification payment that is reliably reversed/refunded afterwards. Either
  // way the backend returns a hosted PaymentURL we redirect to — card data never
  // reaches us — and the binding yields the token we need for future ride
  // charges. Swapping the method is a server env change, not a client change.
  const bindCardMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/payments/tbank/bind-card");
      return (await res.json()) as {
        paymentUrl: string;
        amountKopecks?: number;
        method?: string;
        methodId?: number;
      };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      if (data.paymentUrl && typeof data.methodId === "number") {
        // Открываем hosted-форму T-Bank в МОДАЛЬНОМ iframe (bottom-sheet).
        // Вкладка НЕ уходит на pay.tbank.ru → история не меняется → native
        // swipe-back не может попасть на форму T-Bank. Статус ловим polling'ом.
        setTbankBind({ methodId: data.methodId, url: data.paymentUrl });
      } else if (data.paymentUrl) {
        // Фоллбэк (methodId не пришёл): старый путь через уход вкладки.
        setRedirecting(true);
        window.location.replace(data.paymentUrl);
      }
    },
    onError: (e: Error) =>
      toast.toast({ title: "Не удалось привязать карту", description: cleanErr(e), variant: "destructive" }),
  });

  // Start a real SBP ACCOUNT binding via AddAccountQr. The backend returns a QR
  // payload/deeplink and the id of a pending sbp-type method. We open a modal
  // showing the QR (scan from another device) + an "Открыть в банке" deeplink
  // button (tap on the same phone). The AccountToken arrives asynchronously once
  // the rider authorises in their bank, so the modal polls refresh-bind-sbp
  // until the method activates (or fails). If the SBP-recurrent product isn't
  // activated on the terminal, the backend relays T-Bank's message and we show
  // it via cleanErr — no crash.
  const bindSbpMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/payments/tbank/bind-sbp");
      return (await res.json()) as { methodId: number; requestKey: string | null; qrPayload: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      setSbpBinding({ methodId: data.methodId, payload: data.qrPayload, status: "waiting" });
    },
    onError: (e: Error) =>
      toast.toast({ title: "Не удалось привязать счёт СБП", description: cleanErr(e), variant: "destructive" }),
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

  // Poll the in-progress SBP binding while its modal is open. The AccountToken
  // arrives asynchronously (the rider authorises in their bank), so we poll
  // refresh-bind-sbp every 2s for up to ~2min. On "active" we flip the modal to
  // its success state (and refresh the list); on "failed" we show the acquirer's
  // reason. Stops as soon as the binding resolves or the modal closes.
  useEffect(() => {
    if (!sbpBinding || sbpBinding.status !== "waiting") return;
    const methodId = sbpBinding.methodId;
    let tries = 0;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiRequest("GET", `/api/payments/tbank/refresh-bind-sbp/${methodId}`);
        const m = (await res.json()) as PaymentMethod;
        if (cancelled) return;
        if (m.status === "active") {
          queryClient.invalidateQueries({ queryKey: METHODS_KEY });
          setSbpBinding((b) => (b && b.methodId === methodId ? { ...b, status: "active" } : b));
        } else if (m.status === "failed") {
          queryClient.invalidateQueries({ queryKey: METHODS_KEY });
          setSbpBinding((b) =>
            b && b.methodId === methodId ? { ...b, status: "failed", error: methodError(m) } : b,
          );
        }
      } catch {
        // Transient poll failure (e.g. the state query was rejected) — keep
        // waiting; the notification webhook may still resolve the binding.
      }
    };
    const interval = setInterval(() => {
      if (++tries >= 60) {
        clearInterval(interval);
        return;
      }
      void poll();
    }, 2000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sbpBinding?.methodId, sbpBinding?.status]);

  // Привязка карты через МОДАЛЬНЫЙ iframe (bottom-sheet), а НЕ через уход вкладки
  // на pay.tbank.ru. Раньше форма открывалась в той же вкладке
  // (window.location.replace) — тогда T-Bank создавал цепочку cross-origin
  // записей в истории (форма → 3DS → return), и нативный iOS swipe-back попадал
  // на pay.tbank.ru. Удалить cross-origin записи JS не может (проверено), поэтому
  // единственное надёжное решение — НЕ уводить вкладку с takeride.ru вообще:
  // история вкладки не меняется, свайпать некуда.
  //
  // Результат привязки НЕ доверяем URL внутри iframe — авторитетен серверный
  // webhook. Ловим двумя путями: (1) polling статуса созданной записи (methodId)
  // каждые 2с; (2) postMessage от iframe при возврате на ?from=tbank (ускоряет
  // закрытие). Модалка закрывается, когда карта active/failed или по таймауту.
  const bindFrame = tbankBind; // { methodId, url } | null — состояние объявлено выше

  // Ловим postMessage от iframe (index.html шлёт tbank:done при возврате).
  useEffect(() => {
    if (!bindFrame) return;
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.type !== "tbank:done") return;
      // Явный отказ — сразу показываем ошибку и закрываем.
      if (d.hasSuccess && !d.success) {
        const code = d.errorCode;
        toast.toast({
          title: "Не удалось привязать карту",
          description: code && code !== "0" ? `Банк вернул код ${code}.` : "Привязка карты была отклонена.",
          variant: "destructive",
        });
        setTbankBind(null);
        queryClient.invalidateQueries({ queryKey: METHODS_KEY });
        return;
      }
      // Успех/Init: не закрываем сразу — даём polling подтвердить статус по
      // webhook (active), но форсируем немедленный refetch для скорости.
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindFrame?.methodId]);

  // Polling статуса привязываемой карты, пока открыта модалка. Как только запись
  // становится active — закрываем модалку с успехом; failed — с ошибкой.
  // ~2 мин максимум, затем оставляем список на авто-reconcile выше.
  useEffect(() => {
    if (!bindFrame) return;
    const methodId = bindFrame.methodId;
    let tries = 0;
    let cancelled = false;
    const poll = async () => {
      try {
        // refresh-bind опрашивает T-Bank GetState по paymentId (Init-путь);
        // для AddCard-строк есть requestKey — обе ручки идемпотентны.
        const res = await apiRequest("GET", `/api/payments/tbank/refresh-bind/${methodId}`).catch(
          () => apiRequest("POST", `/api/payment-methods/${methodId}/refresh`),
        );
        const m = (await res.json()) as PaymentMethod;
        if (cancelled) return;
        if (m.status === "active") {
          queryClient.invalidateQueries({ queryKey: METHODS_KEY });
          toast.toast({ title: "Карта привязана" });
          setTbankBind(null);
        } else if (m.status === "failed") {
          queryClient.invalidateQueries({ queryKey: METHODS_KEY });
          toast.toast({
            title: "Привязка не удалась",
            description: methodError(m),
            variant: "destructive",
          });
          setTbankBind(null);
        }
      } catch {
        // Транзиентная ошибка опроса — продолжаем ждать webhook.
      }
    };
    const interval = setInterval(() => {
      if (++tries >= 60) {
        clearInterval(interval);
        return;
      }
      void poll();
    }, 2000);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindFrame?.methodId]);

  const busy =
    bindCardMut.isPending ||
    bindSbpMut.isPending ||
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

  // Start a real SBP account binding. Same guards as the card flow: acquiring
  // must be configured and the rider registered. Multiple SBP accounts ARE
  // allowed — no "already linked" short-circuit. The QR modal then walks the
  // rider through authorising the binding in their bank.
  const handleAddSbp = () => {
    if (userLoading || cfgQ.isLoading) return;
    if (!tbankConfigured) {
      toast.toast({
        title: "Платежи настраиваются",
        description: "Привязка счёта СБП будет доступна позже.",
      });
      return;
    }
    if (!isRegistered) {
      toast.toast({
        title: "Нужен вход в аккаунт",
        description: "Войдите, чтобы привязать счёт СБП.",
      });
      return;
    }
    bindSbpMut.mutate();
  };

  const cardBusy = redirecting || bindCardMut.isPending;
  const sbpBusy = bindSbpMut.isPending;

  return (
    <OverlayShell title="Способы оплаты">
      <div className="px-4 py-6 max-w-md mx-auto" data-testid="page-payment-methods">
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
            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left"
          >
            {sbpBusy ? (
              <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
                <Loader2 className="w-5 h-5 animate-spin" />
              </span>
            ) : (
              <SbpBrandIcon />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-gray-900 dark:text-white">
                {methods.some((m) => m.type === "sbp" && (m.status === "active" || m.status === "pending"))
                  ? "Добавить ещё счёт СБП"
                  : "Добавить счёт СБП"}
              </p>
              <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">
                {sbpBusy ? "Готовим QR…" : "Оплата по СБП — привязка без карты"}
              </p>
            </div>
            {!sbpBusy && (
              <Plus className="w-5 h-5 text-gray-400 dark:text-zinc-500 shrink-0" />
            )}
          </button>
        </div>
      </div>

      {sbpBinding && (
        <SbpBindModal
          binding={sbpBinding}
          onClose={() => setSbpBinding(null)}
        />
      )}

      {tbankBind && (
        <TbankBindModal
          url={tbankBind.url}
          onClose={() => {
            // Закрытие вручную: дотягиваем статус (webhook/polling мог ещё не
            // отработать) и обновляем список — авто-reconcile выше доведёт.
            setTbankBind(null);
            queryClient.invalidateQueries({ queryKey: METHODS_KEY });
          }}
        />
      )}
    </OverlayShell>
  );
}

// Модальный bottom-sheet с hosted-формой T-Bank во встроенном iframe. Вкладка
// НЕ уходит на pay.tbank.ru — форма живёт внутри iframe, история вкладки
// не меняется, native swipe-back некуда вести. Статус привязки отслеживает
// родитель (polling + postMessage) и закрывает модалку через onClose.
function TbankBindModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60"
      data-testid="tbank-bind-modal"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-background rounded-t-2xl sm:rounded-2xl sm:mb-4 overflow-hidden flex flex-col animate-slide-up"
        style={{ height: "90vh", maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка с кнопкой закрытия */}
        <div className="relative flex items-center justify-center shrink-0 border-b border-border py-3">
          <h2 className="text-base font-semibold text-foreground">Привязка карты</h2>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full hover:bg-muted transition-colors"
          >
            <X className="w-5 h-5 text-foreground" />
          </button>
        </div>
        {/* iframe с формой T-Bank */}
        <div className="relative flex-1">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          )}
          <iframe
            src={url}
            title="Привязка карты T-Bank"
            className="w-full h-full border-0"
            allow="payment"
            onLoad={() => setLoading(false)}
          />
        </div>
      </div>
    </div>
  );
}

// Modal walking the rider through an SBP account binding. Shows the QR (scan
// with another device's camera / bank app) plus an "Открыть в банке" button
// that opens the deeplink on the same phone. The parent polls the binding
// status and flips `binding.status` to "active"/"failed", which this modal
// reflects. The payload is a bank deeplink/URL rendered locally as a QR (no
// network), so the account credential never leaves the rider's device path.
function SbpBindModal({
  binding,
  onClose,
}: {
  binding: SbpBinding;
  onClose: () => void;
}) {
  // Whether the payload is openable as a link on this device. SBP payloads are
  // https:// or a bank-scheme deeplink; either is safe to hand to the browser.
  const canOpen = /^(https?:|[a-z][a-z0-9+.-]*:)/i.test(binding.payload.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      data-testid="sbp-bind-modal"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-sm bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl border border-gray-200 dark:border-zinc-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-2">
          <h2 className="text-lg font-display font-light text-gray-900 dark:text-white">
            Привязка счёта СБП
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="button-close-sbp-modal"
            className="flex items-center justify-center w-9 h-9 rounded-full text-gray-500 dark:text-zinc-400 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pb-6">
          {binding.status === "active" ? (
            <div className="flex flex-col items-center text-center py-6" data-testid="sbp-bind-success">
              <CheckCircle2 className="w-14 h-14 text-green-500" />
              <p className="mt-3 text-base font-semibold text-gray-900 dark:text-white">Счёт СБП привязан</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-zinc-400">
                Теперь можно оплачивать поездки через СБП.
              </p>
              <button
                type="button"
                onClick={onClose}
                data-testid="button-sbp-done"
                className="mt-5 w-full py-3 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold hover:opacity-90 transition-opacity"
              >
                Готово
              </button>
            </div>
          ) : binding.status === "failed" ? (
            <div className="flex flex-col items-center text-center py-6" data-testid="sbp-bind-failed">
              <AlertCircle className="w-14 h-14 text-red-500" />
              <p className="mt-3 text-base font-semibold text-gray-900 dark:text-white">Не удалось привязать счёт</p>
              {binding.error && (
                <p className="mt-1 text-sm text-red-500">{binding.error}</p>
              )}
              <button
                type="button"
                onClick={onClose}
                data-testid="button-sbp-close-failed"
                className="mt-5 w-full py-3 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold hover:opacity-90 transition-opacity"
              >
                Закрыть
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <p className="text-sm text-gray-500 dark:text-zinc-400 text-center mb-4">
                Отсканируйте QR камерой или приложением банка, а на этом телефоне — нажмите «Открыть в банке».
              </p>
              <div className="rounded-2xl bg-white p-3 border border-gray-200" data-testid="sbp-qr">
                <BikeQr value={binding.payload} size={220} />
              </div>
              {canOpen && (
                <a
                  href={binding.payload}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="button-open-in-bank"
                  className="mt-5 w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold hover:opacity-90 transition-opacity"
                >
                  <ExternalLink className="w-4 h-4" />
                  Открыть в банке
                </a>
              )}
              <div className="mt-4 flex items-center gap-2 text-xs text-gray-400 dark:text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Ждём подтверждения в банке…</span>
              </div>
            </div>
          )}
        </div>
      </div>
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

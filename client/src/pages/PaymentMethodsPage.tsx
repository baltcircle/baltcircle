import { useEffect, useRef, useState } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PublicPaymentMethod } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { fmtDate } from "@/lib/format";
import { TBANK_CONFIG_KEY, type TbankConfigResponse } from "@/lib/payment";
import {
  CreditCard, Loader2, Trash2, Plus,
} from "lucide-react";
import { CardBrandIcon, SbpBrandIcon } from "@/components/PaymentBrandIcon";
import visaLogo from "@/assets/payment-icons/visa.svg";
import mastercardLogo from "@/assets/payment-icons/mastercard.svg";
import mirLogo from "@/assets/payment-icons/mir.svg";
import sbpLogo from "@/assets/payment-icons/sbp.svg";
import {
  type SbpBinding,
  partitionPendingBindings,
  refreshPendingMethod,
  cancelTimedOutPendingMethod,
  visiblePaymentMethods,
  statusLabel,
  methodError,
  cleanErr,
} from "./payment-methods/binding-utils";
import { TbankBindModal } from "./payment-methods/TbankBindModal";
import { SbpBindModal } from "./payment-methods/SbpBindModal";

const METHODS_KEY = ["/api/payment-methods"];
const PENDING_POLL_INTERVAL_MS = 3_000;
const ACCEPTED_PAYMENT_METHODS = [
  { src: visaLogo, alt: "Visa" },
  { src: mastercardLogo, alt: "Mastercard" },
  { src: mirLogo, alt: "МИР" },
  { src: sbpLogo, alt: "СБП" },
] as const;

export function PaymentMethodsPage() {
  const toast = useToast();
  const { isRegistered, isLoading: userLoading } = useCurrentUser();
  const [redirecting, setRedirecting] = useState(false);
  const [sbpBinding, setSbpBinding] = useState<SbpBinding | null>(null);
  // Модальный iframe привязки карты: url — hosted-форма T-Bank, methodId — созданная
  // pending-запись для polling. null — модалка закрыта.
  const [tbankBind, setTbankBind] = useState<{ methodId: number; url: string } | null>(null);
  const timedOutBindingIds = useRef(new Set<number>());
  const pendingBindingIds = useRef(new Set<number>());
  const lastPendingPollAt = useRef(0);

  const methodsQ = useQuery<PublicPaymentMethod[]>({ queryKey: METHODS_KEY });
  const methods = methodsQ.data ?? [];
  const visibleMethods = visiblePaymentMethods(methods);

  // Probe whether real T-Bank acquiring is configured. When it is not, we show a
  // "Платежи настраиваются" notice instead of offering a flow that would 503.
  const cfgQ = useQuery<TbankConfigResponse>({ queryKey: TBANK_CONFIG_KEY });
  const tbankConfigured = cfgQ.data?.configured === true;

  // A webhook can update the list between poll responses. Detect a pending →
  // failed transition in fetched data too, so the binding modal reflects the
  // authoritative terminal state. Terminal bind failures update an open binding
  // modal but do not produce a page-level notification or persistent list row.
  useEffect(() => {
    const previousPending = pendingBindingIds.current;
    methods
      .filter((method) => method.status === "failed" && previousPending.has(method.id))
      .forEach((method) => {
        if (tbankBind?.methodId === method.id) setTbankBind(null);
        setSbpBinding((binding) =>
          binding?.methodId === method.id
            ? { ...binding, status: "failed", error: methodError(method) }
            : binding,
        );
      });
    pendingBindingIds.current = new Set(
      methods.filter((method) => method.status === "pending").map((method) => method.id),
    );
  }, [methods, tbankBind?.methodId, toast]);

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
        // swipe-back не может попасть на форму T-Bank. Статус ловим общим фоновым polling'ом.
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
  // the rider authorises in their bank, so page-level background polling checks
  // refresh-bind-sbp until the method activates (or fails). If the SBP-recurrent product isn't
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

  // Keep pending bindings out of the list and reconcile them silently in the
  // background. This runs after remount too: the fetched list is the source of
  // truth, so an unfinished redirect/QR flow continues where it left off.
  // `createdAt` is intentional here — every refresh writes `updatedAt`, which
  // must not postpone the three-minute safety valve indefinitely.
  useEffect(() => {
    const { pollable, timedOut } = partitionPendingBindings(methods, Date.now());
    timedOut.forEach((method) => {
      if (!timedOutBindingIds.current.has(method.id)) {
        timedOutBindingIds.current.add(method.id);
        // This is only a secondary safety check. For T-Bank cards the server
        // first synchronously asks GetAddCardState/GetState: a just-resolved
        // active/failed row is retained, while a still-pending row is
        // explicitly cancelled so it cannot remain a local bind lock. The
        // legacy/SBP cleanup remains idempotent. Do not show a speculative
        // timeout failure before the authoritative response says it failed.
        void cancelTimedOutPendingMethod(method)
          .then(() => queryClient.invalidateQueries({ queryKey: METHODS_KEY }))
          .catch(() => {
            // The normal list/load reconciliation retries on the next visit;
            // never expose a local timer guess as a binding result.
          });
      }
    });
    if (pollable.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      if (Date.now() - lastPendingPollAt.current < PENDING_POLL_INTERVAL_MS) return;
      lastPendingPollAt.current = Date.now();

      const refreshed = await Promise.all(
        pollable.map(async (method) => {
          try {
            return await refreshPendingMethod(method);
          } catch {
            // A transient state-query failure must not expose a pending row or
            // stop the next scheduled background reconciliation attempt.
            return null;
          }
        }),
      );
      if (cancelled) return;

      refreshed.forEach((method) => {
        if (!method) return;
        if (method.status === "failed") {
          // Keep an open SBP modal in context without a disruptive toast; failed
          // bindings never remain as persistent payment-method list rows.
          if (tbankBind?.methodId === method.id) setTbankBind(null);
          setSbpBinding((binding) =>
            binding?.methodId === method.id
              ? { ...binding, status: "failed", error: methodError(method) }
              : binding,
          );
        } else if (method.status === "active") {
          if (tbankBind?.methodId === method.id) setTbankBind(null);
          setSbpBinding((binding) =>
            binding?.methodId === method.id ? { ...binding, status: "active" } : binding,
          );
        }
      });
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
    };

    void poll();
    const interval = window.setInterval(() => void poll(), PENDING_POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methods, tbankBind?.methodId]);

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
      // The return URL is only a hint: obtain the authoritative terminal state
      // from the server before deciding whether this was a cancellation or a
      // genuine bank decline. In particular, a T-Bank cancel must not create a
      // scary local failure toast before reconciliation can hide it.
      if (d.hasSuccess && !d.success) {
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

  const busy =
    bindCardMut.isPending ||
    bindSbpMut.isPending ||
    unlinkMut.isPending ||
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
        <section
          className="mb-4 rounded-2xl border border-card-border bg-card overflow-hidden"
          aria-labelledby="accepted-payment-methods-heading"
          data-testid="accepted-payment-methods"
        >
          <div className="px-4 pt-4">
            <h2
              id="accepted-payment-methods-heading"
              className="text-base font-semibold text-gray-900 dark:text-white"
            >
              Принимаем к оплате
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Банковские карты и СБП
            </p>
          </div>
          <ul className="flex flex-wrap items-center gap-3 px-4 py-4">
            {ACCEPTED_PAYMENT_METHODS.map((method) => (
              <li
                key={method.alt}
                className="flex h-10 min-w-[62px] items-center justify-center rounded-lg border border-gray-200 bg-white px-2 shadow-sm dark:border-zinc-700"
              >
                <img
                  src={method.src}
                  alt={method.alt}
                  className="h-7 w-auto max-w-[58px] object-contain"
                />
              </li>
            ))}
          </ul>
        </section>

        {/* Linked methods — profile-style rows */}
        <div
          className="rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-800"
          data-testid="card-linked-methods"
        >
          {methodsQ.isLoading ? (
            <div className="px-4 py-4 text-sm text-muted-foreground" data-testid="methods-loading">
              Загрузка…
            </div>
          ) : visibleMethods.length === 0 ? (
            <div className="px-4 py-4 text-sm text-muted-foreground" data-testid="methods-empty">
              Пока нет привязанных способов оплаты.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-zinc-700" data-testid="methods-list">
              {visibleMethods.map((m) => {
                const st = statusLabel(m.status);
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
                {methods.some((m) => m.type === "card" && m.status === "active")
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
                {methods.some((m) => m.type === "sbp" && m.status === "active")
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

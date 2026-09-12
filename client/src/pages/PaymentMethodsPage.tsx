import { useEffect, useRef, useState } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PublicPaymentMethod } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { TBANK_CONFIG_KEY, type TbankConfigResponse } from "@/lib/payment";
import {
  CreditCard, Loader2, Trash2,
} from "lucide-react";
import { CardBrandIcon, SbpBrandIcon } from "@/components/PaymentBrandIcon";
import type { SbpBank } from "@shared/sbp";
import {
  type SbpBinding,
  partitionPendingBindings,
  refreshPendingMethod,
  cancelTimedOutPendingMethod,
  visiblePaymentMethods,
  methodError,
  cleanErr,
  detectSbpDeviceType,
  fetchSbpBanks,
  startSbpBinding,
  isOpenablePayload,
} from "./payment-methods/binding-utils";
import { SbpBindModal } from "./payment-methods/SbpBindModal";

const METHODS_KEY = ["/api/payment-methods"];
const SBP_BANKS_KEY = ["/api/payments/tbank/sbp-banks"];
// 1.5с вместо прежних 3с — основной рычаг ощутимой задержки появления
// карты/СБП-счёта в списке: единственный, что не завязан на внешний RTT до
// T-Bank. lastPendingPollAt ниже принудительно сбрасывается в местах, где мы
// точно знаем о завершении банковской сессии (postMessage, закрытие попапа),
// чтобы не ждать остаток текущего интервала.
const PENDING_POLL_INTERVAL_MS = 1_500;

export function PaymentMethodsPage() {
  const toast = useToast();
  const { isRegistered, isLoading: userLoading } = useCurrentUser();
  const [redirecting, setRedirecting] = useState(false);
  const [sbpBinding, setSbpBinding] = useState<SbpBinding | null>(null);
  // Открыта ли модалка СБП. Шаг выбора банка идёт до того, как появится
  // binding, поэтому видимость хранится отдельно от самого binding.
  const [sbpModalOpen, setSbpModalOpen] = useState(false);
  // Модальный iframe привязки карты: url — hosted-форма T-Bank, methodId — созданная
  // pending-запись для polling. null — модалка закрыта.
  const [tbankBind, setTbankBind] = useState<{ methodId: number; url: string } | null>(null);
  const timedOutBindingIds = useRef(new Set<number>());
  const pendingBindingIds = useRef(new Set<number>());
  const lastPendingPollAt = useRef(0);
  // Попап, открытый СИНХРОННО в самом click-хендлере (см. handleAddCard) —
  // до await мутации. Браузеры считают попап "легитимным", только если
  // window.open вызван в том же тике, что и user gesture; наш bind-card идёт
  // через сетевой запрос за URL, и к моменту ответа gesture уже "остывает" —
  // именно это и вызывает промпт "сайт пытается открыть всплывающее окно".
  // Поэтому открываем пустое окно сразу по тапу, а когда придёт URL —
  // просто переводим уже открытое окно на него (popup.location.href), без
  // повторного window.open.
  const pendingPopupRef = useRef<Window | null>(null);

  const POPUP_WIDTH = 430;
  const POPUP_HEIGHT = 760;
  const popupFeatures = () => {
    const left = Math.max(0, Math.round((window.screen.width - POPUP_WIDTH) / 2));
    const top = Math.max(0, Math.round((window.screen.height - POPUP_HEIGHT) / 2));
    return `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},resizable=yes,scrollbars=yes`;
  };
  // Открывает пустое окно прямо в текущем event-тике (сохраняя user gesture) и
  // рисует в нём лоадер в теме приложения (фон + акцент как на странице), чтобы
  // переход "наше окно → форма банка" не выглядел как две разные всплывашки —
  // визуально это один и тот же экран, который просто заполняется контентом.
  const openPendingPopup = () => {
    const popup = window.open("", "tbank-bind", popupFeatures());
    if (popup) {
      const dark = document.documentElement.classList.contains("dark");
      const bg = dark ? "#18181b" : "#ffffff";
      const fg = dark ? "#a1a1aa" : "#71717a";
      const ring = dark ? "#3f3f46" : "#e4e4e7";
      popup.document.write(
        '<!doctype html><meta charset="utf-8"><title>Переход в банк…</title>' +
          `<body style="margin:0;height:100vh;background:${bg};display:flex;` +
          "flex-direction:column;align-items:center;justify-content:center;gap:16px;" +
          `font-family:system-ui,-apple-system,sans-serif;color:${fg}">` +
          `<div style="width:36px;height:36px;border-radius:50%;border:3px solid ${ring};` +
          `border-top-color:${fg};animation:spin 0.8s linear infinite"></div>` +
          '<div style="font-size:14px">Открываем форму банка…</div>' +
          "<style>@keyframes spin{to{transform:rotate(360deg)}}</style>",
      );
    }
    pendingPopupRef.current = popup;
    return popup;
  };

  // Глобальный defaultOptions отключает refetchOnWindowFocus и держит staleTime: Infinity.
  // Наш ручной invalidateQueries (postMessage/закрытие попапа/polling) покрывает
  // большинство случаев, но не все: на мобильных браузерах попап банка иногда
  // открывается в той же вкладке/возвратает через App-свитч/PWA-lifecycle
  // иначе, и ни один из наших триггеров мог не сработать — тогда список оставался
  // старым до ручной перезагрузки. "always" — надёжная сеть: при возврате фокуса на
  // вкладку (закрыли попап, вернулись из банковского приложения на мобильном) список
  // всё равно переспрашивается, без ручного обновления страницы.
  const methodsQ = useQuery<PublicPaymentMethod[]>({
    queryKey: METHODS_KEY,
    refetchOnWindowFocus: "always",
  });
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
        // Открываем hosted-форму T-Bank в отдельном ПОПАПе (T-Bank блокирует
        // встраивание своей формы в iframe). Вкладка НЕ уходит на pay.tbank.ru →
        // история не меняется. Статус ловим общим фоновым polling'ом.
        // попап уже открыт синхронно (openPendingPopup в handleAddCard) —
        // эффект ниже только переведёт его на URL, никакого нового window.open.
        setTbankBind({ methodId: data.methodId, url: data.paymentUrl });
      } else if (data.paymentUrl) {
        // Фоллбэк (methodId не пришёл): старый путь через уход вкладки.
        // предварительно открытый попап больше не нужен — закрываем, чтобы не
        // оставались пустые окна с лоадером.
        pendingPopupRef.current?.close();
        pendingPopupRef.current = null;
        setRedirecting(true);
        window.location.replace(data.paymentUrl);
      } else {
        pendingPopupRef.current?.close();
        pendingPopupRef.current = null;
      }
    },
    onError: (e: Error) => {
      // заранее открытый пустой попап надо закрыть — иначе останется пустое
      // окно с вечным лоадером.
      pendingPopupRef.current?.close();
      pendingPopupRef.current = null;
      toast.toast({ title: "Не удалось привязать карту", description: cleanErr(e), variant: "destructive" });
    },
  });

  // Start a real SBP ACCOUNT binding via AddAccountQr. The backend returns a QR
  // payload/deeplink and the id of a pending sbp-type method. We open a modal
  // showing the QR (scan from another device) + an "Открыть в банке" deeplink
  // button (tap on the same phone). The AccountToken arrives asynchronously once
  // the rider authorises in their bank, so page-level background polling checks
  // refresh-bind-sbp until the method activates (or fails). If the SBP-recurrent product isn't
  // activated on the terminal, the backend relays T-Bank's message and we show
  // it via cleanErr — no crash.

  // Список банков-участников СБП. Грузится только когда модалка открыта:
  // это подписанный запрос к эквайреру, а не данные страницы. Ошибка не
  // блокирует привязку — пикер показывает запасной путь через QR.
  const banksQ = useQuery<SbpBank[]>({
    queryKey: SBP_BANKS_KEY,
    queryFn: () => fetchSbpBanks(detectSbpDeviceType()),
    enabled: sbpModalOpen && tbankConfigured,
    staleTime: 30 * 60 * 1_000,
    retry: false,
  });

  const bindSbpMut = useMutation({
    mutationFn: async (bank: SbpBank | null) => {
      const data = await startSbpBinding(bank?.id);
      return { data, bank };
    },
    onSuccess: ({ data, bank }) => {
      queryClient.invalidateQueries({ queryKey: METHODS_KEY });
      // Райдер выбрал банк — значит payload это его deeplink, и тап по банку
      // должен вести в приложение сразу, без промежуточного экрана
      // подтверждения — закрываем модалку и сразу уводим. Фоновый polling
      // pending-метода (см. эффект ниже) догонит статус сам — без тоста и без
      // участия открытой модалки. Переход только на тач-устройствах: в
      // десктопном браузере банковской схемы нет, там модалка остаётся со своей
      // кнопкой/QR, как и раньше.
      if (bank && isOpenablePayload(data.qrPayload) && detectSbpDeviceType() === "mobile") {
        setSbpModalOpen(false);
        setSbpBinding(null);
        window.location.assign(data.qrPayload);
        return;
      }
      setSbpBinding({
        methodId: data.methodId,
        payload: data.qrPayload,
        status: "waiting",
        ...(bank ? { bankName: bank.name } : {}),
      });
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

  // Привязка карты через отдельный ПОПАП (window.open), а НЕ через iframe и НЕ
  // через уход вкладки на pay.tbank.ru (window.location.replace). История двух
  // предыдущих вариантов: (1) полный window.location.replace создавал
  // cross-origin записи в истории, нативный iOS swipe-back попадал на
  // pay.tbank.ru; (2) iframe-модалка решала это, но T-Bank отдаёт
  // X-Frame-Options/CSP frame-ancestors и свою hosted-форму в iframe НЕ
  // рендерит вообще (подтверждено). Попап — самостоятельный top-level
  // контекст: анти-фрейминг не мешает, и наша вкладка не навигируется вообще,
  // так что swipe-back не активен.
  //
  // Результат привязки НЕ доверяем URL внутри попапа — авторитетен серверный
  // webhook. Ловим двумя путями: (1) polling статуса созданной записи (methodId)
  // каждые 2с; (2) postMessage от попапа при возврате на ?from=tbank (ускоряет
  // закрытие). Никакого собственного оверлея/модалки над страницей нет —
  // tbankBind живёт только как служебное состояние для попапа и polling'а;
  // сбрасывается, когда карта active/failed, попап закрыт вручную или по таймауту.
  const bindFrame = tbankBind; // { methodId, url } | null — состояние объявлено выше

  // Открываем попап сразу, как только появился tbankBind — без какой-либо
  // собственной модалки/оверлея над страницей. Если браузер блокирует попап
  // (мобильные браузеры иногда не считают ответ мутации "свежим" жестом), не
  // показываем запасной UI, а сразу уходим вкладкой на hosted-форму — тем же
  // путём, что и фоллбэк выше без methodId, — чтобы райдер не остался без
  // возможности продолжить привязку.
  const openedBindMethodId = useRef<number | null>(null);
  const bindPopupRef = useRef<Window | null>(null);
  useEffect(() => {
    if (!tbankBind || openedBindMethodId.current === tbankBind.methodId) return;
    openedBindMethodId.current = tbankBind.methodId;
    const { url, methodId } = tbankBind;
    // Переиспользуем попап, открытый СИНХРОННО в click-хендлере (см.
    // openPendingPopup/handleAddCard) — просто переводим его на нужный URL.
    // Это сохраняет user gesture и не вызывает промпт "сайт пытается открыть
    // всплывающее окно". Новый window.open здесь — только запасной путь
    // (например, если pendingPopupRef уже сброшен по какой-то причине).
    // Deliberately no "noopener" — the return page (?from=tbank) needs
    // window.opener to postMessage the result back and self-close.
    let popup = pendingPopupRef.current;
    pendingPopupRef.current = null;
    if (popup && !popup.closed) {
      popup.location.href = url;
    } else {
      popup = window.open(url, "tbank-bind", popupFeatures());
    }
    bindPopupRef.current = popup;
    const blockCheck = window.setTimeout(() => {
      if (openedBindMethodId.current !== methodId) return;
      if (!popup || popup.closed) {
        // Попап заблокирован — уходим вкладкой на hosted-форму вместо показа
        // собственного UI поверх страницы.
        setTbankBind(null);
        setRedirecting(true);
        window.location.replace(url);
      }
    }, 500);
    const closePoll = window.setInterval(() => {
      if (bindPopupRef.current?.closed) {
        window.clearInterval(closePoll);
        if (openedBindMethodId.current === methodId) {
          // Закрытие вручную: дотягиваем статус (webhook/polling мог ещё не
          // отработать) и обновляем список — авто-reconcile выше доведёт.
          // Сброс throttle — следующий тик поллинга (эффект перезапустится от
          // смены methods/tbankBind) не будет ждать остаток интервала.
          setTbankBind(null);
          lastPendingPollAt.current = 0;
          queryClient.invalidateQueries({ queryKey: METHODS_KEY });
        }
      }
    }, 300);
    return () => {
      window.clearTimeout(blockCheck);
      window.clearInterval(closePoll);
    };
  }, [tbankBind]);

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
        lastPendingPollAt.current = 0;
        queryClient.invalidateQueries({ queryKey: METHODS_KEY });
        return;
      }
      // Успех/Init: не закрываем сразу — даём polling подтвердить статус по
      // webhook (active), но форсируем немедленный refetch для скорости, и
      // сбрасываем throttle поллинга, чтобы следующий тик не ждал интервал.
      lastPendingPollAt.current = 0;
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
    // Открываем пустое окно ПРЯМО тут — в том же тике, что и клик кнопки, до
    // асинхронного запроса за URL. Иначе к моменту ответа сервера user gesture
    // утерян, и браузер трактует window.open как всплывающее окно и просит
    // разрешение.
    openPendingPopup();
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
    setSbpBinding(null);
    setSbpModalOpen(true);
  };

  const closeSbpModal = () => {
    setSbpModalOpen(false);
    setSbpBinding(null);
    bindSbpMut.reset();
  };

  const cardBusy = redirecting || bindCardMut.isPending;
  const sbpBusy = bindSbpMut.isPending;
  // "" — запасной QR-путь (без банка); null — ничего не запущено.
  const startingBankId = bindSbpMut.isPending
    ? (bindSbpMut.variables?.id ?? "")
    : null;

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
          ) : visibleMethods.length === 0 ? (
            <div className="px-4 py-4 text-sm text-muted-foreground" data-testid="methods-empty">
              Пока нет привязанных способов оплаты.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-zinc-700" data-testid="methods-list">
              {visibleMethods.map((m) => {
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

        {/* Add actions — раздельные карточки с небольшим отступом между ними */}
        <div className="mt-4 space-y-2">
          <button
            type="button"
            disabled={busy}
            onClick={handleAddSbp}
            data-testid="button-add-sbp"
            className="w-full px-4 py-3 rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 flex items-center justify-center gap-3 hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sbpBusy ? (
              <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
                <Loader2 className="w-5 h-5 animate-spin" />
              </span>
            ) : (
              <SbpBrandIcon />
            )}
            <p className="text-base font-semibold text-gray-900 dark:text-white">
              Добавить счёт СБП
            </p>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={handleAddCard}
            data-testid="button-bind-card"
            className="w-full px-4 py-3 rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 flex items-center justify-center gap-3 hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
              {cardBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <CreditCard className="w-5 h-5" />}
            </span>
            <p className="text-base font-semibold text-gray-900 dark:text-white">
              Добавить карту
            </p>
          </button>
        </div>
      </div>

      {sbpModalOpen && (
        <SbpBindModal
          binding={sbpBinding}
          banks={banksQ.data ?? []}
          banksLoading={banksQ.isLoading}
          banksFailed={banksQ.isError}
          startingBankId={startingBankId}
          starting={bindSbpMut.isPending}
          onPickBank={(bank) => bindSbpMut.mutate(bank)}
          onUseQr={() => bindSbpMut.mutate(null)}
          onClose={closeSbpModal}
        />
      )}

    </OverlayShell>
  );
}

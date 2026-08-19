import { useEffect, useRef, useState } from "react";
import { CreditCard, Loader2, X } from "lucide-react";

// T-Bank's hosted card-bind page refuses to render inside an iframe (blocked
// by X-Frame-Options/CSP frame-ancestors on their side — confirmed: the same
// URL opens and works fine as a plain new tab, but silently never fires
// iframe onLoad). A same-origin-looking small POPUP WINDOW is not framing —
// it is a completely separate top-level browsing context, so the bank's
// anti-framing header does not apply, and it keeps the previous "small
// window" feel instead of taking over the whole tab.
const POPUP_NAME = "tbank-bind";
const POPUP_WIDTH = 430;
const POPUP_HEIGHT = 760;
// Popup blockers can return a non-null Window handle that is closed almost
// immediately, or return null outright, or (Safari) return a real window
// that never actually navigates. Give it a brief moment to settle before
// deciding it was blocked.
const POPUP_BLOCK_CHECK_MS = 500;
// How often we poll popup.closed to notice the rider closing the T-Bank
// window themselves. The actual bind result is never trusted from this —
// the parent page's background status poll + server-side webhook remain
// authoritative; this only drives *our* waiting UI.
const POPUP_CLOSE_POLL_MS: number = 700;

function openBindPopup(url: string): Window | null {
  const left = Math.max(0, Math.round((window.screen.width - POPUP_WIDTH) / 2));
  const top = Math.max(0, Math.round((window.screen.height - POPUP_HEIGHT) / 2));
  // Deliberately no "noopener" — the return page (?from=tbank) needs
  // window.opener to postMessage the result back to us and self-close.
  return window.open(
    url,
    POPUP_NAME,
    `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},resizable=yes,scrollbars=yes`,
  );
}

// Компактное окно поверх "Способов оплаты", пока рядом открыто настоящее
// маленькое окно с формой T-Bank. Сама форма живёт в window.open-попапе (не в
// iframe — банк блокирует встраивание), поэтому наша вкладка вообще не
// навигируется и история не меняется. Результат привязки отслеживает
// родитель (polling + postMessage от окна-попапа) и закрывает это окно через
// onClose; здесь мы только управляем самим попапом и статусом "открыт/закрыт/заблокирован".
export function TbankBindModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [blocked, setBlocked] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const openedRef = useRef(false);

  const reopen = () => {
    const popup = openBindPopup(url);
    popupRef.current = popup;
    if (popup) {
      setBlocked(false);
      popup.focus();
    } else {
      setBlocked(true);
    }
  };

  // Открываем попап один раз при монте — это прямое следствие клика "Привязать
  // карту" (мутация уже завершилась к этому моменту), так что часть браузеров
  // может посчитать вызов недостаточно "свежим" относительно жеста пользователя
  // и заблокировать его. Проверяем это и показываем запасную ссылку — клик по
  // ней сам является новым жестом и не блокируется никогда.
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    const popup = openBindPopup(url);
    popupRef.current = popup;
    const check = setTimeout(() => {
      if (!popup || popup.closed) setBlocked(true);
    }, POPUP_BLOCK_CHECK_MS);
    return () => clearTimeout(check);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Если пользователь сам закрыл окно T-Bank — просто закрываем это окно
  // ожидания. Итоговый статус (active/failed) всё равно приходит из
  // фонового опроса в родителе независимо от того, открыта эта карточка или нет.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        window.clearInterval(interval);
        onClose();
      }
    }, POPUP_CLOSE_POLL_MS);
    return () => window.clearInterval(interval);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60"
      data-testid="tbank-bind-modal"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-background rounded-t-2xl sm:rounded-2xl sm:mb-4 overflow-hidden flex flex-col animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
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
        <div className="flex flex-col items-center gap-4 px-6 py-8 text-center">
          {!blocked ? (
            <>
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                Заполните данные карты в открывшемся окне T-Bank. Это окно
                закроется автоматически, когда привязка завершится.
              </p>
              <button
                onClick={reopen}
                className="flex items-center gap-2 text-sm font-medium text-primary"
              >
                <CreditCard className="w-4 h-4" />
                Не вижу окно — открыть снова
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Браузер заблокировал всплывающее окно. Откройте форму банка вручную.
              </p>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={onClose}
                className="w-full rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground text-center"
              >
                Открыть форму банка
              </a>
            </>
          )}
          <button
            onClick={onClose}
            className="w-full rounded-full border border-border py-2.5 text-sm font-medium text-foreground"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

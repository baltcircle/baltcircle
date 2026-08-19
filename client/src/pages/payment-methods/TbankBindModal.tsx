import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";

// Модальный bottom-sheet с hosted-формой T-Bank во встроенном iframe. Вкладка
// НЕ уходит на pay.tbank.ru — форма живёт внутри iframe, история вкладки
// не меняется, native swipe-back некуда вести. Статус привязки отслеживает
// родитель (polling + postMessage) и закрывает модалку через onClose.
export function TbankBindModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);

  // Защита от native swipe-back пока модалка открыта. iframe (и сама форма
  // T-Bank со своими внутренними переходами) добавляет записи в историю
  // ВЕРХНЕГО окна (проверено: +N записей), и native swipe попадал в них
  // («тянет в привязку»). Решение, работающее и в Safari, и в Chromium: на
  // каждый popstate СРАЗУ возвращаем сентинел обратно (ре-pushState) и
  // закрываем модалку. Свайп не может уйти глубже, чем на сентинел.
  // (contentWindow.location.replace НЕ используем: в Safari доступ к
  // contentWindow свежего about:blank iframe гоночный и кидает/молчит.)
  useEffect(() => {
    let alive = true;
    // Запоминаем глубину истории ДО открытия, чтобы при закрытии
    // снять ВСЕ записи, которые накидали сентинел + iframe/форма.
    const baseLen = history.length;
    history.pushState({ bcTbankModal: true }, "");
    const onPop = () => {
      if (!alive) return;
      // Свайп/назад съел сентинел (или iframe-запись) — мгновенно
      // восстанавливаем барьер и закрываем модалку, не давая уйти
      // на pay.tbank.ru / вглубь iframe-записей.
      history.pushState({ bcTbankModal: true }, "");
      onClose();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      alive = false;
      window.removeEventListener("popstate", onPop);
      // Откатываем ВСЕ записи, добавленные пока модалка была
      // открыта (сентинел + внутренние переходы iframe/формы),
      // чтобы после закрытия свайп на /payment-methods не попал на
      // оставшиеся pay.tbank.ru-записи.
      const extra = history.length - baseLen;
      if (extra > 0) history.go(-extra);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {/* iframe с формой T-Bank. src задаём атрибутом (надёжно во всех
            браузерах). Лишние записи истории от iframe ловит сентинел выше. */}
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

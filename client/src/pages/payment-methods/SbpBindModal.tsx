import { AlertCircle, CheckCircle2, ExternalLink, Loader2, X } from "lucide-react";
import { BikeQr } from "@/components/BikeQr";
import type { SbpBinding } from "./binding-utils";

// Modal walking the rider through an SBP account binding. Shows the QR (scan
// with another device's camera / bank app) plus an "Открыть в банке" button
// that opens the deeplink on the same phone. The parent polls the binding
// status and flips `binding.status` to "active"/"failed", which this modal
// reflects. The payload is a bank deeplink/URL rendered locally as a QR (no
// network), so the account credential never leaves the rider's device path.
export function SbpBindModal({
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

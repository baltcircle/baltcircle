import { AlertCircle, CheckCircle2, ExternalLink, Loader2, X } from "lucide-react";
import { BikeQr } from "@/components/BikeQr";
import type { SbpBank } from "@shared/sbp";
import { SbpBankPicker } from "./SbpBankPicker";
import { type SbpBinding, isOpenablePayload } from "./binding-utils";

// Modal walking the rider through an SBP account binding.
//
// Step 1 (`binding === null`) is the bank list: tapping a bank starts the
// binding against its BankId, so the acquirer answers with that bank's deeplink
// and the rider goes straight into the bank app.
//
// Step 2 is the authorisation wait. With a bank chosen we lead with "Открыть
// в <банк>" and keep the QR below (the deeplink can fail if the app isn't
// installed, and a desktop rider needs the QR anyway). Without a bank it is the
// original generic-QR screen. The parent polls the binding status and flips
// `binding.status` to "active"/"failed", which this modal reflects.
//
// The payload is a bank deeplink/URL rendered locally as a QR (no network), so
// the account credential never leaves the rider's device path.
export function SbpBindModal({
  binding,
  banks,
  banksLoading,
  banksFailed,
  startingBankId,
  starting,
  onPickBank,
  onUseQr,
  onClose,
}: {
  binding: SbpBinding | null;
  banks: SbpBank[];
  banksLoading: boolean;
  banksFailed: boolean;
  // Id of the bank whose binding is being created; "" while the QR fallback is
  // starting. Drives the per-row spinner.
  startingBankId: string | null;
  starting: boolean;
  onPickBank: (bank: SbpBank) => void;
  onUseQr: () => void;
  onClose: () => void;
}) {
  const canOpen = binding !== null && isOpenablePayload(binding.payload);

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
            {binding === null ? "Выберите банк" : "Привязка счёта СБП"}
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
          {binding === null ? (
            <SbpBankPicker
              banks={banks}
              loading={banksLoading}
              failed={banksFailed}
              startingBankId={startingBankId}
              disabled={starting}
              onPickBank={onPickBank}
              onUseQr={onUseQr}
            />
          ) : binding.status === "active" ? (
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
                {binding.bankName
                  ? `Подтвердите привязку в приложении «${binding.bankName}». Если оно не открылось — нажмите кнопку ниже или отсканируйте QR.`
                  : "Отсканируйте QR камерой или приложением банка, а на этом телефоне — нажмите «Открыть в банке»."}
              </p>

              {canOpen && binding.bankName && (
                <a
                  href={binding.payload}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="button-open-in-bank"
                  className="mb-4 w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold hover:opacity-90 transition-opacity"
                >
                  <ExternalLink className="w-4 h-4" />
                  Открыть «{binding.bankName}»
                </a>
              )}

              <div className="rounded-2xl bg-white p-3 border border-gray-200" data-testid="sbp-qr">
                <BikeQr value={binding.payload} size={220} />
              </div>

              {canOpen && !binding.bankName && (
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

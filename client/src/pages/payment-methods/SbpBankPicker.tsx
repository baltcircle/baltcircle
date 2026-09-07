import { useMemo, useState } from "react";
import { AlertCircle, Loader2, QrCode, Search } from "lucide-react";
import type { SbpBank } from "@shared/sbp";
import { filterSbpBanks } from "@shared/sbp";

// Bank logo with an initials fallback. The URL is a third-party asset we do not
// control (and the server only ever forwards https ones), so a broken or slow
// image must degrade to something readable rather than an empty box.
function BankLogo({ bank }: { bank: SbpBank }) {
  const [broken, setBroken] = useState(false);
  const initials = bank.name.replace(/[«»"']/g, "").trim().slice(0, 1).toUpperCase();

  if (!bank.logoUrl || broken) {
    return (
      <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground text-sm font-semibold shrink-0">
        {initials || "?"}
      </span>
    );
  }
  return (
    <img
      src={bank.logoUrl}
      alt=""
      loading="lazy"
      decoding="async"
      width={36}
      height={36}
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="w-9 h-9 rounded-full object-contain bg-white border border-gray-200 shrink-0"
    />
  );
}

// Bank list for an SBP account binding. Tapping a bank starts the binding
// against that bank's BankId, so the acquirer answers with its deeplink and the
// rider lands straight in their bank app — no QR step in between.
//
// The QR path stays reachable ("Показать QR"): it is the only option on a
// desktop browser, and it is also the fallback when the member list itself is
// unavailable, so a bad list can never block the binding entirely.
export function SbpBankPicker({
  banks,
  loading,
  failed,
  startingBankId,
  disabled,
  onPickBank,
  onUseQr,
}: {
  banks: SbpBank[];
  loading: boolean;
  failed: boolean;
  startingBankId: string | null;
  disabled: boolean;
  onPickBank: (bank: SbpBank) => void;
  onUseQr: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterSbpBanks(banks, query), [banks, query]);

  return (
    <div className="flex flex-col" data-testid="sbp-bank-picker">
      <p className="text-sm text-gray-500 dark:text-zinc-400 mb-3">
        Выберите банк, в котором открыт счёт — привязку нужно подтвердить в его приложении.
      </p>

      {banks.length > 8 && (
        <div className="relative mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-zinc-500 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск банка"
            data-testid="input-bank-search"
            className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-gray-100 dark:bg-zinc-800 text-base text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-500 outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-zinc-600"
          />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-400 dark:text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Загружаем банки…</span>
        </div>
      ) : failed || banks.length === 0 ? (
        <div
          className="flex flex-col items-center text-center py-6 px-2"
          data-testid="sbp-banks-unavailable"
        >
          <AlertCircle className="w-10 h-10 text-gray-300 dark:text-zinc-600" />
          <p className="mt-3 text-sm text-gray-500 dark:text-zinc-400">
            Список банков сейчас недоступен. Привязку можно завершить по QR-коду.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400 dark:text-zinc-500">
          Банк не найден
        </p>
      ) : (
        <ul className="max-h-[50vh] overflow-y-auto -mx-1 px-1 divide-y divide-gray-100 dark:divide-zinc-800">
          {visible.map((bank) => {
            const starting = startingBankId === bank.id;
            return (
              <li key={bank.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onPickBank(bank)}
                  data-testid={`button-sbp-bank-${bank.id}`}
                  className="w-full py-3 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-zinc-800/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed rounded-xl px-2"
                >
                  <BankLogo bank={bank} />
                  <span className="flex-1 min-w-0 text-base text-gray-900 dark:text-white truncate">
                    {bank.name}
                  </span>
                  {starting && (
                    <Loader2 className="w-4 h-4 animate-spin text-gray-400 dark:text-zinc-500 shrink-0" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={onUseQr}
        data-testid="button-sbp-use-qr"
        className="mt-4 w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl border border-gray-200 dark:border-zinc-700 text-gray-700 dark:text-zinc-200 font-medium hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {startingBankId === "" ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <QrCode className="w-4 h-4" />
        )}
        Показать QR-код
      </button>
    </div>
  );
}

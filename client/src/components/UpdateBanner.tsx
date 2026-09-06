import { RefreshCw, X } from "lucide-react";

import { useAppUpdate } from "@/hooks/use-app-update";

/**
 * Ненавязчивое предложение перезагрузиться, когда на сервере появилась новая
 * сборка. Показывается поверх всего, но не блокирует интерфейс: во время
 * поездки прерывать пользователя модалкой нельзя.
 */
export function UpdateBanner() {
  const { updateReady, applyUpdate, dismiss } = useAppUpdate();

  if (!updateReady) return null;

  return (
    <div
      className="fixed inset-x-0 z-[60] flex justify-center px-3 pointer-events-none"
      style={{ top: "max(env(safe-area-inset-top, 0px), 12px)" }}
      data-testid="banner-app-update"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border border-card-border bg-card px-3 py-2.5 shadow-lg">
        <RefreshCw className="h-5 w-5 shrink-0 text-primary" strokeWidth={2.25} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight text-foreground">Доступна новая версия</p>
          <p className="mt-0.5 text-xs leading-tight text-muted-foreground">
            Обновится за секунду, поездка не прервётся.
          </p>
        </div>
        <button
          type="button"
          onClick={applyUpdate}
          data-testid="button-app-update-apply"
          className="shrink-0 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Обновить
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Позже"
          data-testid="button-app-update-dismiss"
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-black/10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

import { Lock, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  /** какое действие ждёт закрытия замка — меняет текст и заголовок. */
  mode: "pause" | "end";
  /** вызывается при любом способе закрыть окно (крестик, backdrop, Esc, кнопка «Отмена») — само действие (пауза/завершение) не выполняется. */
  onCancel: () => void;
  cancelling: boolean;
}

/**
 * Полноэкранный модальный поверх, появляющийся сразу после нажатия «Пауза»
 * или «Завершить поездку» для велосипеда с умным замком: пока OMNI не
 * подтвердит физическое закрытие замка, действие не применяется (см.
 * requestPauseRide/requestEndRide на сервере). Пользователь может закрыть
 * окно принудительно — тогда действие отменяется (resume/cancel-end), ничего
 * не происходит с поездкой.
 */
export function AwaitingLockCloseDialog({ open, mode, onCancel, cancelling }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !cancelling) onCancel(); }}>
      <DialogContent
        className="max-w-sm rounded-3xl text-center [&>button]:hidden"
        data-testid="dialog-awaiting-lock-close"
      >
        <div className="flex flex-col items-center gap-3 py-2">
          <div className="w-16 h-16 rounded-full bg-brand-sea-soft flex items-center justify-center">
            <Lock className="w-9 h-9 text-brand-sea" />
          </div>
          <DialogTitle className="font-display font-light text-lg">
            Закройте замок велосипеда
          </DialogTitle>
          <DialogDescription className="text-sm">
            {mode === "end"
              ? "Поездка завершится автоматически, как только замок закроется."
              : "Поездка встанет на паузу автоматически, как только замок закроется."}
          </DialogDescription>
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mt-1" />
          <Button
            type="button"
            variant="ghost"
            className="mt-2"
            onClick={onCancel}
            disabled={cancelling}
            data-testid="button-cancel-awaiting-lock-close"
          >
            {cancelling && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Отмена
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

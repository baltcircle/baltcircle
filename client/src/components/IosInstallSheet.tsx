import { Share, SquarePlus, BellRing, Check } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { dismissIosInstallHintForever } from "@/lib/pwa";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * true — окно открылось само (при старте аренды): показываем «Больше не
   * показывать». При ручном открытии из меню такая кнопка бессмысленна.
   */
  auto?: boolean;
}

interface StepProps {
  n: number;
  icon: React.ElementType;
  title: string;
  hint: string;
}

function Step({ n, icon: Icon, title, hint }: StepProps) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold tabular-nums text-primary">
        {n}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[15px] font-medium leading-snug text-gray-900 dark:text-white">
          {title}
          <Icon className="h-[18px] w-[18px] shrink-0 text-primary" strokeWidth={2.25} />
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-gray-500 dark:text-zinc-400">
          {hint}
        </span>
      </span>
    </li>
  );
}

/**
 * Инструкция «Добавить на экран Домой» для iPhone/iPad.
 *
 * На iOS нет программной установки PWA (beforeinstallprompt не существует),
 * поэтому единственный рабочий вариант — объяснить три шага вручную. Без
 * установки на экран «Домой» Safari не даёт подписаться на push-уведомления,
 * то есть это ещё и предусловие для уведомлений о поездке.
 */
export function IosInstallSheet({ open, onOpenChange, auto = false }: Props) {
  const handleNeverAgain = () => {
    dismissIosInstallHintForever();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="dialog-ios-install">
        <DialogHeader>
          <DialogTitle className="text-left">Установите TakeRide на экран «Домой»</DialogTitle>
          <DialogDescription className="text-left">
            Приложение откроется на весь экран, без адресной строки — и только так iPhone
            разрешает присылать уведомления о поездке.
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-4 py-1">
          <Step
            n={1}
            icon={Share}
            title="Нажмите «Поделиться»"
            hint="Кнопка внизу Safari — квадрат со стрелкой вверх."
          />
          <Step
            n={2}
            icon={SquarePlus}
            title="Выберите «На экран „Домой“»"
            hint="Пролистайте список действий чуть ниже."
          />
          <Step
            n={3}
            icon={Check}
            title="Нажмите «Добавить»"
            hint="Иконка TakeRide появится рядом с остальными приложениями."
          />
        </ol>

        <div className="flex items-start gap-3 rounded-xl bg-primary/10 px-3 py-2.5">
          <BellRing className="mt-0.5 h-[18px] w-[18px] shrink-0 text-primary" strokeWidth={2.25} />
          <p className="text-[13px] leading-snug text-gray-700 dark:text-zinc-300">
            После установки откройте приложение с экрана «Домой», войдите и включите
            уведомления в настройках профиля — будем предупреждать об окончании
            оплаченного времени и списаниях.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:flex-col-reverse sm:gap-2">
          {auto && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleNeverAgain}
              data-testid="button-ios-install-never"
              className="w-full text-gray-500 dark:text-zinc-400"
            >
              Больше не показывать
            </Button>
          )}
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            data-testid="button-ios-install-ok"
            className="w-full"
          >
            Понятно
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

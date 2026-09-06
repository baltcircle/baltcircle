import { useState } from "react";
import { BellRing, Clock, Wallet, Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { subscribePush, pushStateLabel, isPushSupported, type PushState } from "@/lib/push";
import { dismissPushOptInForever } from "@/lib/push-optin";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Вызывается после успешной подписки — чтобы обновить состояние в настройках. */
  onSubscribed?: (state: PushState) => void;
}

function Row({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <li className="flex items-start gap-3">
      <Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-primary" strokeWidth={2.25} />
      <span className="text-[14px] leading-snug text-gray-700 dark:text-zinc-300">{text}</span>
    </li>
  );
}

/**
 * Предложение включить уведомления при первом запуске установленной PWA.
 *
 * Разрешение нельзя выдать за пользователя: браузеры требуют явного действия,
 * а Safari — чтобы requestPermission() был вызван синхронно из обработчика
 * жеста. Тап по «Включить» и есть этот жест; своё окно перед системным нужно,
 * потому что системный запрос показывается один раз за установку — случайный
 * отказ из веба уже не переспросить.
 */
export function PushOptInSheet({ open, onOpenChange, onSubscribed }: Props) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const handleEnable = async () => {
    setBusy(true);
    try {
      // requestPermission вызывается ПЕРВЫМ действием, до любых await:
      // Safari даёт на запрос только окно «transient activation» после жеста,
      // и ожидание готовности SW внутри subscribePush могло бы его съесть.
      if (isPushSupported() && Notification.permission === "default") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          toast.toast({
            title: "Уведомления не включены",
            description: permission === "denied"
              ? "Разрешение отклонено. Вернуть его можно в настройках iPhone → TakeRide."
              : "Можно включить позже в настройках профиля.",
            variant: "destructive",
          });
          onOpenChange(false);
          return;
        }
      }
      const state = await subscribePush();
      onSubscribed?.(state);
      if (state === "granted-subscribed") {
        toast.toast({
          title: "Уведомления включены",
          description: "Предупредим за 10 и за 5 минут до конца аренды и когда начнётся овертайм.",
        });
        onOpenChange(false);
      } else {
        // denied / default / unsupported — окно закрываем, но объясняем результат.
        toast.toast({
          title: "Уведомления не включены",
          description: `${pushStateLabel(state)}. Включить можно в настройках профиля.`,
          variant: "destructive",
        });
        onOpenChange(false);
      }
    } catch (err) {
      toast.toast({
        title: "Не удалось включить уведомления",
        description: err instanceof Error ? err.message : "Попробуйте из настроек профиля.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleNeverAgain = () => {
    dismissPushOptInForever();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-w-sm" data-testid="dialog-push-optin">
        <DialogHeader>
          <DialogTitle className="text-left flex items-center gap-2">
            <BellRing className="h-5 w-5 shrink-0 text-primary" strokeWidth={2.25} />
            Включить уведомления?
          </DialogTitle>
          <DialogDescription className="text-left">
            Чтобы не потерять деньги на овертайме, когда приложение свёрнуто.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-3 py-1">
          <Row icon={Clock} text="Предупредим за 10 и за 5 минут до конца оплаченного времени." />
          <Row icon={BellRing} text="Сообщим, когда начнётся овертайм." />
          <Row icon={Wallet} text="Никакой рекламы и рассылок — только по вашим поездкам." />
        </ul>

        <DialogFooter className="gap-2 sm:flex-col-reverse sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={handleNeverAgain}
            data-testid="button-push-optin-never"
            className="w-full text-gray-500 dark:text-zinc-400"
          >
            Не сейчас
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={handleEnable}
            data-testid="button-push-optin-enable"
            className="w-full"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Включить уведомления"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

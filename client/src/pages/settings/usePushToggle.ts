import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { getPushState, subscribePush, unsubscribePush, type PushState } from "@/lib/push";

export function usePushToggle() {
  const toast = useToast();
  const [pushState, setPushState] = useState<PushState>("default");
  const [pushBusy, setPushBusy] = useState(false);

  // Подтягиваем текущее состояние push при монтировании.
  useEffect(() => {
    let cancelled = false;
    getPushState().then((s) => { if (!cancelled) setPushState(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const pushOn = pushState === "granted-subscribed";
  const pushDisabled =
    pushBusy ||
    pushState === "unsupported" ||
    pushState === "ios-need-standalone" ||
    pushState === "denied";

  async function togglePush() {
    if (pushDisabled) {
      if (pushState === "ios-need-standalone") {
        toast.toast({
          title: "Добавьте приложение на экран «Домой»",
          description: "iOS Safari показывает push только в установленном PWA. Откройте Поделиться → На экран «Домой».",
        });
      } else if (pushState === "denied") {
        toast.toast({
          title: "Уведомления заблокированы",
          description: "Разрешите уведомления в настройках браузера для этого сайта.",
        });
      }
      return;
    }
    setPushBusy(true);
    try {
      const next = pushOn ? await unsubscribePush() : await subscribePush();
      setPushState(next);
      if (next === "granted-subscribed") {
        toast.toast({ title: "Push включены" });
      } else if (next === "denied") {
        toast.toast({
          title: "Разрешение отклонено",
          description: "Включить можно в настройках браузера.",
        });
      }
    } catch (err) {
      toast.toast({
        title: "Не удалось переключить push",
        description: (err as Error)?.message ?? "Попробуйте ещё раз.",
        variant: "destructive",
      });
    } finally {
      setPushBusy(false);
    }
  }

  return { pushState, pushOn, pushBusy, pushDisabled, togglePush };
}

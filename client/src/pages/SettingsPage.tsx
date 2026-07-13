import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useTheme } from "@/lib/theme";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CURRENT_USER_KEY } from "@/hooks/use-current-user";
import type { User as UserType } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { PhoneChangeModal } from "@/components/PhoneChangeModal";
import { EmailChangeModal } from "@/components/EmailChangeModal";
import { ArrowLeft, ChevronRight, Sun, Moon, Bell } from "lucide-react";
import {
  getPushState, subscribePush, unsubscribePush, pushStateLabel,
  type PushState,
} from "@/lib/push";

export function SettingsPage() {
  const toast = useToast();
  const { user, isRegistered } = useCurrentUser();
  const { mode, setMode } = useTheme();

  const [name, setName] = useState(user?.name ?? "");
  const [editingName, setEditingName] = useState(false);
  const [pushState, setPushState] = useState<PushState>("default");
  const [pushBusy, setPushBusy] = useState(false);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [emailModalOpen, setEmailModalOpen] = useState(false);

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

  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
    }
  }, [user]);

  const saveMut = useMutation<UserType, Error, { name: string }>({
    mutationFn: async (patch) => {
      const res = await apiRequest("PATCH", "/api/users/me", patch);
      return res.json();
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(CURRENT_USER_KEY, updated);
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });
      setEditingName(false);
      toast.toast({ title: "Сохранено" });
    },
    onError: (err) => {
      toast.toast({ title: "Ошибка", description: err?.message, variant: "destructive" });
    },
  });

  return (
    // Full viewport, no scroll, uniform background
    <div
      className="flex flex-col bg-gray-50 dark:bg-zinc-900 h-full overflow-y-auto"
      data-testid="page-settings"
    >
      {/* Header */}
      <div
        className="relative flex items-center justify-center px-4 shrink-0 bg-gray-50 dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800"
        style={{ paddingTop: "calc(max(1.25rem, env(safe-area-inset-top)) + 1rem)", paddingBottom: "1rem" }}
      >
        <button
          onClick={() => window.dispatchEvent(new Event("overlay:back"))}
          className="absolute left-4 flex items-center justify-center w-9 h-9 rounded-full hover:bg-gray-200 dark:hover:bg-zinc-800 transition-colors"
          style={{ top: "calc(max(1.25rem, env(safe-area-inset-top)) + 1rem)", bottom: "1rem", marginTop: "auto", marginBottom: "auto", height: "2.25rem" }}
        >
          <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-zinc-300" />
        </button>
        <h1 className="text-base font-semibold text-gray-900 dark:text-white">Профиль</h1>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col px-4 pt-6 pb-4 gap-3 min-h-0">

        {/* User data */}
        <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-800 shrink-0">
          {/* Name */}
          <div
            className="px-4 py-3 border-b border-gray-100 dark:border-zinc-700 cursor-pointer"
            onClick={() => isRegistered && setEditingName(v => !v)}
          >
            {editingName ? (
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                onBlur={() => saveMut.mutate({ name: name.trim() })}
                onKeyDown={e => e.key === "Enter" && saveMut.mutate({ name: name.trim() })}
                className="w-full text-base font-semibold text-gray-900 dark:text-white bg-transparent border-b border-blue-500 outline-none"
              />
            ) : (
              <p className="text-base font-semibold text-gray-900 dark:text-white">{name || "—"}</p>
            )}
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Твоё имя</p>
          </div>

          {/* Phone */}
          <button
            type="button"
            onClick={() => setPhoneModalOpen(true)}
            className="w-full px-4 py-3 border-b border-gray-100 dark:border-zinc-700 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors"
          >
            <div className="text-left">
              <p className="text-base font-semibold text-gray-900 dark:text-white">{user?.phone ?? "—"}</p>
              <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Номер телефона</p>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-400 dark:text-zinc-500 shrink-0" />
          </button>

          {/* Email */}
          <button
            type="button"
            onClick={() => setEmailModalOpen(true)}
            className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors"
          >
            <div className="text-left">
              <p className="text-base font-semibold text-gray-900 dark:text-white">{user?.email ?? "—"}</p>
              <p className="text-xs mt-0.5">
                <span className="text-gray-400 dark:text-zinc-500">Email</span>
                {user?.emailVerifiedAt && <span className="text-green-500 ml-1">· Подтверждён</span>}
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-gray-400 dark:text-zinc-500 shrink-0" />
          </button>
        </div>

        {/* Push notifications */}
        <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 overflow-hidden shrink-0">
          <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Уведомления</p>
          <div className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Bell className="w-5 h-5 text-gray-400 dark:text-zinc-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-900 dark:text-white">Push уведомления</p>
                <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5 truncate">
                  {pushStateLabel(pushState)}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={togglePush}
              aria-checked={pushOn}
              role="switch"
              disabled={pushDisabled && pushState !== "ios-need-standalone" && pushState !== "denied"}
              className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${
                pushOn ? "bg-primary" : "bg-gray-200 dark:bg-zinc-600"
              } ${pushBusy ? "opacity-60" : ""} ${pushState === "unsupported" ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                  pushOn ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Theme */}
        <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 overflow-hidden shrink-0">
          <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Настройки приложения</p>
          <div className="px-4 py-3">
            <p className="text-base font-semibold text-gray-900 dark:text-white mb-3">Тема приложения</p>
            <div className="flex rounded-full bg-muted p-1 gap-1">
              {(["system", "light", "dark"] as const).map((m) => {
                const active = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`flex-1 flex items-center justify-center h-8 rounded-full text-sm font-medium transition-all ${
                      active
                        ? "bg-primary text-primary-foreground shadow"
                        : "text-muted-foreground"
                    }`}
                  >
                    {m === "system" && "Авто"}
                    {m === "light" && <Sun className="w-4 h-4" />}
                    {m === "dark" && <Moon className="w-4 h-4" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Consent */}
        {isRegistered && user?.consentAcceptedAt && (
          <p className="text-xs text-gray-400 dark:text-zinc-500 px-1 shrink-0">
            Согласие на обработку данных принято{user.consentVersion ? ` · версия ${user.consentVersion}` : ""}.
          </p>
        )}
      </div>

      <PhoneChangeModal open={phoneModalOpen} onOpenChange={setPhoneModalOpen} />
      <EmailChangeModal open={emailModalOpen} onOpenChange={setEmailModalOpen} />
    </div>
  );
}

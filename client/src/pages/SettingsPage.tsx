import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useTheme } from "@/lib/theme";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CURRENT_USER_KEY } from "@/hooks/use-current-user";
import type { User as UserType, OauthIdentity, OauthProvider } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { PhoneChangeModal } from "@/components/PhoneChangeModal";
import { EmailChangeModal } from "@/components/EmailChangeModal";
import { ArrowLeft, ChevronRight, Sun, Moon, Bell, Mail } from "lucide-react";

const OAUTH_KEY = ["/api/users/me/oauth"] as const;

export function SettingsPage() {
  const toast = useToast();
  const { user, isRegistered } = useCurrentUser();
  const { mode, setMode } = useTheme();

  const [name, setName] = useState(user?.name ?? "");
  const [editingName, setEditingName] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [emailModalOpen, setEmailModalOpen] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
    }
  }, [user]);

  // React to /settings?oauth=... redirect from OAuth callbacks. We only show
  // toasts here and let the query below refresh the list of linked identities.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const state = params.get("oauth");
    const provider = params.get("provider");
    if (!state) return;
    const name = provider === "yandex" ? "Yandex" : provider === "vk" ? "VK" : "аккаунт";
    if (state === "linked") toast.toast({ title: `${name} привязан` });
    else if (state === "signed-in") toast.toast({ title: `Вход через ${name}` });
    else if (state === "error") {
      const reason = params.get("reason");
      toast.toast({
        title: `Не удалось связать ${name}`,
        description: reason === "conflict"
          ? "Этот аккаунт уже привязан к другому пользователю."
          : "Попробуйте ещё раз.",
        variant: "destructive",
      });
    }
    // Clean the URL so the toast doesn't fire again on remount.
    const url = new URL(window.location.href);
    url.searchParams.delete("oauth");
    url.searchParams.delete("provider");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.toString());
    queryClient.invalidateQueries({ queryKey: OAUTH_KEY });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const oauthQuery = useQuery<OauthIdentity[]>({
    queryKey: OAUTH_KEY,
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/users/me/oauth");
      return res.json();
    },
    enabled: isRegistered,
  });

  const unlinkOauthMut = useMutation<void, Error, OauthProvider>({
    mutationFn: async (provider) => {
      await apiRequest("POST", `/api/users/me/oauth/${provider}/unlink`, {});
    },
    onSuccess: (_, provider) => {
      queryClient.invalidateQueries({ queryKey: OAUTH_KEY });
      toast.toast({ title: `${provider === "yandex" ? "Yandex" : "VK"} отвязан` });
    },
    onError: (err) => {
      toast.toast({ title: "Ошибка", description: err?.message, variant: "destructive" });
    },
  });

  const linkedYandex = oauthQuery.data?.find((i) => i.provider === "yandex");
  const linkedVk = oauthQuery.data?.find((i) => i.provider === "vk");

  return (
    // Full viewport, no scroll, uniform background
    <div
      className="flex flex-col bg-gray-50 dark:bg-zinc-900 h-full overflow-y-auto"
      data-testid="page-settings"
    >
      {/* Header */}
      <div
        className="flex items-center justify-center px-4 pb-3 shrink-0 bg-gray-50 dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800"
        style={{ paddingTop: "max(1.25rem, env(safe-area-inset-top))" }}
      >
        <button
          onClick={() => window.dispatchEvent(new Event("overlay:back"))}
          className="absolute left-4 flex items-center justify-center w-9 h-9 rounded-full hover:bg-gray-200 dark:hover:bg-zinc-800 transition-colors"
          style={{ top: "max(1.25rem, env(safe-area-inset-top))" }}
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

        {/* Linked accounts */}
        {isRegistered && (
          <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 overflow-hidden shrink-0">
            <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Привязанные аккаунты</p>

            <LinkedRow
              title="Yandex ID"
              subtitle={linkedYandex ? (linkedYandex.email || linkedYandex.displayName || "Привязан") : "Не привязан"}
              linked={!!linkedYandex}
              onLink={() => { window.location.href = "/api/auth/yandex/start"; }}
              onUnlink={() => unlinkOauthMut.mutate("yandex")}
              disabled={unlinkOauthMut.isPending}
              divider
            />
            <LinkedRow
              title="VK ID"
              subtitle={linkedVk ? (linkedVk.email || linkedVk.displayName || "Привязан") : "Не привязан"}
              linked={!!linkedVk}
              onLink={() => { window.location.href = "/api/auth/vk/start"; }}
              onUnlink={() => unlinkOauthMut.mutate("vk")}
              disabled={unlinkOauthMut.isPending}
            />
          </div>
        )}

        {/* Push notifications */}
        <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 overflow-hidden shrink-0">
          <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Скидки и новости</p>
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell className="w-5 h-5 text-gray-400 dark:text-zinc-500" />
              <span className="text-base font-semibold text-gray-900 dark:text-white">Push уведомления</span>
            </div>
            <button
              type="button"
              onClick={() => setPushEnabled(v => !v)}
              aria-checked={pushEnabled}
              role="switch"
              className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 ${
                pushEnabled ? "bg-primary" : "bg-gray-200 dark:bg-zinc-600"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                  pushEnabled ? "translate-x-5" : "translate-x-0"
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

interface LinkedRowProps {
  title: string;
  subtitle: string;
  linked: boolean;
  onLink: () => void;
  onUnlink: () => void;
  disabled?: boolean;
  divider?: boolean;
}

function LinkedRow({ title, subtitle, linked, onLink, onUnlink, disabled, divider }: LinkedRowProps) {
  return (
    <div className={`px-4 py-3 flex items-center justify-between ${divider ? "border-b border-gray-100 dark:border-zinc-700" : ""}`}>
      <div className="min-w-0 pr-3">
        <p className="text-base font-semibold text-gray-900 dark:text-white">{title}</p>
        <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5 truncate">{subtitle}</p>
      </div>
      {linked ? (
        <button
          type="button"
          onClick={onUnlink}
          disabled={disabled}
          className="text-sm font-medium text-red-500 hover:text-red-600 disabled:opacity-50"
        >
          Отвязать
        </button>
      ) : (
        <button
          type="button"
          onClick={onLink}
          className="text-sm font-medium text-primary hover:opacity-80"
        >
          Привязать
        </button>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useTheme } from "@/lib/theme";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CURRENT_USER_KEY } from "@/hooks/use-current-user";
import type { Ride, User as UserType } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { PhoneChangeModal } from "@/components/PhoneChangeModal";
import { fmtDistance } from "@/lib/format";
import { ArrowLeft, ChevronRight, Sun, Moon, Bell } from "lucide-react";

export function SettingsPage() {
  const toast = useToast();
  const { user, isRegistered } = useCurrentUser();
  const { mode, setMode } = useTheme();
  const userId = user?.id ?? "";

  const ridesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides", { userId, limit: 100 }],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/rides?userId=${encodeURIComponent(userId)}&limit=100`);
      return res.json();
    },
    enabled: isRegistered && !!userId,
  });
  const rides = ridesQ.data ?? [];
  const totalMeters = rides.reduce((sum, r) => sum + (r.distanceM ?? 0), 0);

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [editingName, setEditingName] = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      setEmail(user.email ?? "");
    }
  }, [user]);

  const saveMut = useMutation<UserType, Error, { name?: string; email?: string }>({
    mutationFn: async (patch) => {
      const res = await apiRequest("PATCH", "/api/users/me", patch);
      return res.json();
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(CURRENT_USER_KEY, updated);
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });
      setEditingName(false);
      setEditingEmail(false);
      toast.toast({ title: "Сохранено" });
    },
    onError: (err) => {
      toast.toast({ title: "Ошибка", description: err?.message, variant: "destructive" });
    },
  });

  return (
    // Full viewport, no scroll, uniform background
    <div
      className="flex flex-col bg-gray-50 dark:bg-zinc-900"
      style={{ height: "var(--app-height, 100svh)" }}
      data-testid="page-settings"
    >
      {/* Header */}
      <div
        className="flex items-center justify-center px-4 pb-3 shrink-0 bg-gray-50 dark:bg-zinc-900"
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

      {/* Content — flex-1, no overflow */}
      <div className="flex-1 flex flex-col px-4 pb-4 gap-3 min-h-0">

        {/* Stats */}
        <div className="flex gap-8 px-1 py-1 shrink-0">
          <div>
            <p className="text-xl font-semibold text-gray-900 dark:text-white tabular-nums">{fmtDistance(totalMeters)}</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">История поездок</p>
          </div>
          <div>
            <p className="text-xl font-semibold text-gray-900 dark:text-white tabular-nums">{rides.length}</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Поездок</p>
          </div>
        </div>

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
          <div
            className="px-4 py-3 cursor-pointer"
            onClick={() => isRegistered && setEditingEmail(v => !v)}
          >
            {editingEmail ? (
              <input
                autoFocus
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onBlur={() => saveMut.mutate({ email: email.trim() })}
                onKeyDown={e => e.key === "Enter" && saveMut.mutate({ email: email.trim() })}
                className="w-full text-base font-semibold text-gray-900 dark:text-white bg-transparent border-b border-blue-500 outline-none"
              />
            ) : (
              <p className="text-base font-semibold text-gray-900 dark:text-white">{email || "—"}</p>
            )}
            <p className="text-xs mt-0.5">
              <span className="text-gray-400 dark:text-zinc-500">Email</span>
              {user?.email && email === user.email && user?.phone && <span className="text-green-500 ml-1">· Подтверждён</span>}
            </p>
          </div>
        </div>

        {/* Push notifications */}
        <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 overflow-hidden shrink-0">
          <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Скидки и новости</p>
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell className="w-5 h-5 text-gray-400 dark:text-zinc-500" />
              <span className="text-base font-semibold text-gray-900 dark:text-white">Push уведомления</span>
            </div>
            {/* Toggle — fixed geometry: track w-11 h-6, thumb w-5 h-5 */}
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
            <div className="flex rounded-full bg-gray-100 dark:bg-zinc-700 p-1 gap-1">
              {(["system", "light", "dark"] as const).map((m) => {
                const active = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`flex-1 flex items-center justify-center h-8 rounded-full text-sm font-medium transition-all ${
                      active
                        ? "bg-white dark:bg-zinc-500 text-gray-900 dark:text-white shadow"
                        : "text-gray-500 dark:text-zinc-400"
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
    </div>
  );
}

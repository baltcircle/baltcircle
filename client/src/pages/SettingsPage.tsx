import { useEffect, useState } from "react";
import { Link } from "wouter";
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
  const { theme, toggle } = useTheme();
  const userId = user?.id ?? "";

  // Ride stats
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

  // Editable fields
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
    <div className="min-h-full bg-white dark:bg-zinc-950" data-testid="page-settings">

      {/* Header */}
      <div className="flex items-center justify-center px-4 pt-5 pb-4 relative">
        <Link href="/" className="absolute left-4 flex items-center justify-center w-9 h-9 rounded-full hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors">
          <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-zinc-300" />
        </Link>
        <h1 className="text-base font-semibold text-gray-900 dark:text-white">Профиль</h1>
      </div>

      {/* Stats row */}
      <div className="flex gap-8 px-5 py-3 border-b border-gray-100 dark:border-zinc-800">
        <div>
          <p className="text-xl font-semibold text-gray-900 dark:text-white tabular-nums">{fmtDistance(totalMeters)}</p>
          <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">История поездок</p>
        </div>
        <div>
          <p className="text-xl font-semibold text-gray-900 dark:text-white tabular-nums">{rides.length}</p>
          <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Поездок</p>
        </div>
      </div>

      {/* User data block */}
      <div className="mx-4 mt-4 rounded-2xl border border-gray-100 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-900">

        {/* Name */}
        <div
          className="px-4 py-4 border-b border-gray-100 dark:border-zinc-800 cursor-pointer"
          onClick={() => isRegistered && setEditingName(v => !v)}
        >
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                onBlur={() => saveMut.mutate({ name: name.trim() })}
                onKeyDown={e => e.key === "Enter" && saveMut.mutate({ name: name.trim() })}
                className="flex-1 text-base font-semibold text-gray-900 dark:text-white bg-transparent border-b border-blue-500 outline-none"
              />
            </div>
          ) : (
            <p className="text-base font-semibold text-gray-900 dark:text-white">{name || "—"}</p>
          )}
          <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Твоё имя</p>
        </div>

        {/* Phone */}
        <button
          type="button"
          onClick={() => setPhoneModalOpen(true)}
          className="w-full px-4 py-4 border-b border-gray-100 dark:border-zinc-800 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-zinc-800/50 transition-colors"
        >
          <div className="text-left">
            <p className="text-base font-semibold text-gray-900 dark:text-white">{user?.phone ?? "—"}</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5">Номер телефона</p>
          </div>
          <ChevronRight className="w-4 h-4 text-gray-400 dark:text-zinc-500 shrink-0" />
        </button>

        {/* Email */}
        <div
          className="px-4 py-4 cursor-pointer"
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
            {email && <span className="text-green-500 ml-1">· Подтверждён</span>}
          </p>
        </div>
      </div>

      {/* Push notifications */}
      <div className="mx-4 mt-4 rounded-2xl border border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Скидки и новости</p>
        <div className="px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bell className="w-5 h-5 text-gray-400 dark:text-zinc-500" />
            <span className="text-base font-semibold text-gray-900 dark:text-white">Push уведомления</span>
          </div>
          <button
            type="button"
            onClick={() => setPushEnabled(v => !v)}
            className={`relative w-12 h-7 rounded-full transition-colors ${pushEnabled ? "bg-blue-500" : "bg-gray-200 dark:bg-zinc-700"}`}
          >
            <span className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow transition-transform ${pushEnabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>
      </div>

      {/* Theme */}
      <div className="mx-4 mt-4 rounded-2xl border border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Настройки приложения</p>
        <div className="px-4 py-4">
          <p className="text-base font-semibold text-gray-900 dark:text-white mb-3">Тема приложения</p>
          <div className="flex rounded-full bg-gray-100 dark:bg-zinc-800 p-1 gap-1">
            {[
              { value: "system", label: "Авто", icon: null },
              { value: "light",  label: null,   icon: Sun },
              { value: "dark",   label: null,   icon: Moon },
            ].map(({ value, label, icon: Icon }) => {
              const active = theme === value || (value === "system" && theme !== "light" && theme !== "dark");
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => { if (value !== theme) toggle(); }}
                  className={`flex-1 flex items-center justify-center h-9 rounded-full text-sm font-medium transition-all ${
                    active
                      ? "bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow"
                      : "text-gray-500 dark:text-zinc-400"
                  }`}
                >
                  {Icon ? <Icon className="w-4 h-4" /> : label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Consent note */}
      {isRegistered && user?.consentAcceptedAt && (
        <p className="mx-4 mt-4 mb-8 text-xs text-gray-400 dark:text-zinc-500">
          Согласие на обработку данных принято{user.consentVersion ? ` · версия ${user.consentVersion}` : ""}.
        </p>
      )}

      <PhoneChangeModal open={phoneModalOpen} onOpenChange={setPhoneModalOpen} />
    </div>
  );
}

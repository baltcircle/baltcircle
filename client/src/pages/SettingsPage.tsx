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
import { ArrowLeft, ChevronRight } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePushToggle } from "./settings/usePushToggle";
import { ProfileSection } from "./settings/ProfileSection";
import { PushNotificationsSection } from "./settings/PushNotificationsSection";
import { ThemeSection } from "./settings/ThemeSection";

export function SettingsPage() {
  const toast = useToast();
  const { user, isRegistered } = useCurrentUser();
  const { mode, setMode } = useTheme();

  const [name, setName] = useState(user?.name ?? "");
  const [editingName, setEditingName] = useState(false);
  const { pushState, pushOn, pushBusy, pushDisabled, togglePush } = usePushToggle();
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

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

  const logoutMut = useMutation<void, Error>({
    mutationFn: async () => {
      await apiRequest("POST", "/api/auth/logout");
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/");
    },
    onError: (err) => {
      toast.toast({ title: "Не удалось выйти", description: err.message, variant: "destructive" });
    },
  });

  const deleteAccountMut = useMutation<void, Error>({
    mutationFn: async () => {
      await apiRequest("DELETE", "/api/account");
    },
    onSuccess: () => {
      queryClient.clear();
      window.location.assign("/");
    },
    onError: (err) => {
      toast.toast({
        title: "Не удалось удалить аккаунт",
        description: err.message,
        variant: "destructive",
      });
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
        className="relative flex items-center justify-center px-4 shrink-0 bg-gray-50 dark:bg-zinc-900 border-t border-b border-gray-200 dark:border-zinc-800"
        style={{ marginTop: "calc(env(safe-area-inset-top) + 0.75rem)", minHeight: "3.5rem" }}
      >
        <button
          onClick={() => window.dispatchEvent(new Event("overlay:back"))}
          className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center justify-center w-9 h-9 rounded-full hover:bg-gray-200 dark:hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-zinc-300" />
        </button>
        <h1 className="text-base font-semibold text-gray-900 dark:text-white">Профиль</h1>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col px-4 pt-6 pb-4 gap-3 min-h-0">

        {/* User data */}
        <ProfileSection
          isRegistered={isRegistered}
          editingName={editingName}
          setEditingName={setEditingName}
          name={name}
          setName={setName}
          onSaveName={() => saveMut.mutate({ name: name.trim() })}
          user={user}
          onOpenPhoneModal={() => setPhoneModalOpen(true)}
          onOpenEmailModal={() => setEmailModalOpen(true)}
        />

        {/* Push notifications */}
        <PushNotificationsSection
          pushState={pushState}
          pushOn={pushOn}
          pushBusy={pushBusy}
          pushDisabled={pushDisabled}
          onToggle={togglePush}
        />

        {/* Theme */}
        <ThemeSection mode={mode} setMode={setMode} />

        {/* Consent */}
        {isRegistered && user?.consentAcceptedAt && (
          <p className="text-xs text-gray-400 dark:text-zinc-500 px-1 shrink-0">
            Согласие на обработку данных принято{user.consentVersion ? ` · версия ${user.consentVersion}` : ""}.
          </p>
        )}

        {isRegistered && (
          <div className="mt-5 shrink-0">
            <button
              type="button"
              onClick={() => setDeleteDialogOpen(true)}
              className="w-full rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 px-4 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors"
              data-testid="button-delete-account"
            >
              <span className="text-base font-semibold text-gray-900 dark:text-white">Удалить аккаунт</span>
              <ChevronRight className="w-5 h-5 text-gray-400 dark:text-zinc-500 shrink-0" />
            </button>

            <button
              type="button"
              onClick={() => logoutMut.mutate()}
              disabled={logoutMut.isPending || deleteAccountMut.isPending}
              className="w-full mt-8 text-sm font-medium text-destructive underline underline-offset-4 disabled:opacity-50"
              data-testid="button-logout"
            >
              {logoutMut.isPending ? "Выходим…" : "Выйти"}
            </button>
          </div>
        )}
      </div>

      <PhoneChangeModal open={phoneModalOpen} onOpenChange={setPhoneModalOpen} />
      <EmailChangeModal open={emailModalOpen} onOpenChange={setEmailModalOpen} />
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent data-testid="dialog-delete-account">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить аккаунт?</AlertDialogTitle>
            <AlertDialogDescription>
              Это действие нельзя отменить. Мы отвяжем сохранённые карты и СБП, удалим данные профиля и
              уведомления. История поездок и платежей останется в обезличенном виде для учёта.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAccountMut.isPending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAccountMut.mutate()}
              disabled={deleteAccountMut.isPending}
              className="bg-destructive text-destructive-foreground border border-destructive-border hover:bg-destructive/90"
              data-testid="button-confirm-delete-account"
            >
              {deleteAccountMut.isPending ? "Удаляем…" : "Удалить"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

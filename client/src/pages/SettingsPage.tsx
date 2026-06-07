import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { useCurrentUser } from "@/hooks/use-current-user";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CURRENT_USER_KEY } from "@/hooks/use-current-user";
import type { User as UserType } from "@shared/schema";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { PhoneChangeModal } from "@/components/PhoneChangeModal";
import { fmtDate } from "@/lib/format";
import { ArrowLeft, User, Moon, Bell, Save, Lock, Smartphone, ShieldCheck, Scale, ChevronRight } from "lucide-react";

export function SettingsPage() {
  const { mode, setMode } = useTheme();
  const toast = useToast();
  const { user, isRegistered } = useCurrentUser();

  // Profile fields. Name/email persist to the backend for a registered rider.
  // Phone is read-only here — changing it requires SMS confirmation, which is
  // not part of this step, so the field is shown but locked.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (user) {
      setName(user.name);
      setEmail(user.email ?? "");
    }
  }, [user]);

  const phone = user?.phone ?? "—";
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);

  const saveProfile = useMutation<UserType, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", "/api/users/me", {
        name: name.trim(),
        email: email.trim(),
      });
      return res.json();
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(CURRENT_USER_KEY, updated);
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });
      toast.toast({ title: "Сохранено", description: "Профиль обновлён." });
    },
    onError: (err) => {
      toast.toast({
        title: "Не удалось сохранить",
        description: err?.message?.replace(/^\d+:\s*/, "") ?? "Попробуйте позже.",
        variant: "destructive",
      });
    },
  });

  // Notification preferences — MVP switches, local state only.
  const [pushOn, setPushOn] = useState(true);
  const [smsOn, setSmsOn] = useState(false);
  const [emailOn, setEmailOn] = useState(true);
  const [ridesOn, setRidesOn] = useState(true);
  const [promosOn, setPromosOn] = useState(false);

  const darkExplicitlyOn = mode === "dark";

  return (
    <div className="min-h-full bg-background" data-testid="page-settings">
      <div className="mx-auto max-w-md px-5 pt-6 pb-12">
        <header className="mb-6 flex items-center gap-3">
          <Link
            href="/profile"
            data-testid="link-settings-back"
            aria-label="Назад в профиль"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground hover-elevate shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              BaltCircle
            </div>
            <h1 className="font-display text-2xl font-light leading-tight">Настройки</h1>
          </div>
        </header>

        {/* Основные */}
        <Section icon={User} title="Основные" testId="section-general">
          <div className="space-y-4">
            {!isRegistered && (
              <p className="text-xs text-muted-foreground" data-testid="text-settings-guest">
                Войдите, чтобы сохранять имя и почту. Гостевые данные не сохраняются.
              </p>
            )}
            <Field>
              <Label htmlFor="settings-name">Имя</Label>
              <Input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ваше имя"
                disabled={!isRegistered}
                data-testid="input-name"
              />
            </Field>
            <Field>
              <Label htmlFor="settings-phone">Номер телефона</Label>
              <Input
                id="settings-phone"
                type="tel"
                inputMode="tel"
                value={phone}
                readOnly
                disabled
                className="opacity-70"
                data-testid="input-phone"
              />
              <p className="text-xs text-muted-foreground flex items-center gap-1" data-testid="text-phone-note">
                <Lock className="w-3 h-3" />
                Смена номера требует подтверждения по SMS.
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={!isRegistered}
                onClick={() => setPhoneModalOpen(true)}
                data-testid="button-change-phone"
              >
                <Smartphone className="w-4 h-4 mr-2" />
                Изменить телефон
              </Button>
            </Field>
            <Field>
              <Label htmlFor="settings-email">Почта</Label>
              <Input
                id="settings-email"
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={!isRegistered}
                data-testid="input-email"
              />
            </Field>
            <Button
              className="w-full"
              data-testid="button-save-general"
              disabled={!isRegistered || saveProfile.isPending}
              onClick={() => saveProfile.mutate()}
            >
              <Save className="w-4 h-4 mr-2" />
              {saveProfile.isPending ? "Сохранение…" : "Сохранить"}
            </Button>

            {isRegistered && (
              <div
                className="rounded-md bg-muted/50 p-3 text-xs flex items-start gap-2"
                data-testid="text-consent-status"
              >
                <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                {user?.consentAcceptedAt ? (
                  <span className="text-muted-foreground">
                    Согласие на обработку данных принято {fmtDate(user.consentAcceptedAt)}
                    {user.consentVersion ? ` · версия ${user.consentVersion}` : ""}.
                  </span>
                ) : (
                  <span className="text-muted-foreground">Согласие на обработку данных не зафиксировано.</span>
                )}
              </div>
            )}
          </div>
        </Section>

        {/* Правовые документы */}
        <Section icon={Scale} title="Правовые документы" testId="section-legal">
          <Link
            href="/legal"
            data-testid="link-settings-legal"
            className="flex items-center gap-3 -m-1 rounded-xl p-3 hover-elevate"
          >
            <span className="flex-1 min-w-0">
              <span className="block font-light">Правовые документы</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                Соглашение, правила проката, конфиденциальность, оплата
              </span>
            </span>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </Link>
        </Section>

        {/* Тема */}
        <Section icon={Moon} title="Тема" testId="section-theme">
          <div className="space-y-4">
            <ToggleRow
              label="Тёмная тема"
              hint="Включить тёмное оформление"
              checked={darkExplicitlyOn}
              onChange={(on) => setMode(on ? "dark" : "light")}
              testId="switch-dark-theme"
            />
            <ToggleRow
              label="Системное оформление"
              hint="Следовать настройкам устройства"
              checked={mode === "system"}
              onChange={(on) => setMode(on ? "system" : "light")}
              testId="switch-system-theme"
            />
            <p className="text-xs text-muted-foreground" data-testid="text-theme-hint">
              {mode === "system"
                ? "Тема подстраивается под оформление вашего устройства."
                : "Тема выбрана вручную."}
            </p>
          </div>
        </Section>

        {/* Уведомления */}
        <Section icon={Bell} title="Уведомления" testId="section-notifications">
          <div className="space-y-4">
            <ToggleRow
              label="Push-уведомления"
              hint="Сообщения в приложении"
              checked={pushOn}
              onChange={setPushOn}
              testId="switch-notify-push"
            />
            <ToggleRow
              label="SMS"
              hint="Уведомления по СМС"
              checked={smsOn}
              onChange={setSmsOn}
              testId="switch-notify-sms"
            />
            <ToggleRow
              label="Email"
              hint="Уведомления на почту"
              checked={emailOn}
              onChange={setEmailOn}
              testId="switch-notify-email"
            />
            <ToggleRow
              label="Напоминания о поездках"
              hint="Статусы и завершение аренды"
              checked={ridesOn}
              onChange={setRidesOn}
              testId="switch-notify-rides"
            />
            <ToggleRow
              label="Акции и новости"
              hint="Скидки и специальные предложения"
              checked={promosOn}
              onChange={setPromosOn}
              testId="switch-notify-promos"
            />
          </div>
        </Section>
      </div>

      <PhoneChangeModal open={phoneModalOpen} onOpenChange={setPhoneModalOpen} />
    </div>
  );
}

function Section({
  icon: Icon, title, testId, children,
}: {
  icon: typeof User;
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-7" data-testid={testId}>
      <div className="flex items-center gap-2 mb-3 px-1">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-display text-lg font-light">{title}</h2>
      </div>
      <div className="rounded-2xl border border-card-border bg-card p-4">{children}</div>
    </section>
  );
}

function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function ToggleRow({
  label, hint, checked, onChange, testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-light">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </div>
  );
}

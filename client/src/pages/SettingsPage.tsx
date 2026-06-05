import { useState } from "react";
import { Link } from "wouter";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, User, Moon, Bell, Save } from "lucide-react";

export function SettingsPage() {
  const { mode, setMode } = useTheme();
  const toast = useToast();

  // Basic profile fields — MVP, local React state only. No real persistence and
  // no sensitive secrets are collected.
  const [name, setName] = useState("Гость");
  const [phone, setPhone] = useState("+7 900 000-00-00");
  const [email, setEmail] = useState("demo@baltcircle.app");

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
            <Field>
              <Label htmlFor="settings-name">Имя</Label>
              <Input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ваше имя"
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
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+7 900 000-00-00"
                data-testid="input-phone"
              />
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
                data-testid="input-email"
              />
            </Field>
            <Button
              className="w-full"
              data-testid="button-save-general"
              onClick={() =>
                toast.toast({
                  title: "Сохранено",
                  description: "MVP: данные сохранены локально, без отправки на сервер.",
                })
              }
            >
              <Save className="w-4 h-4 mr-2" /> Сохранить
            </Button>
          </div>
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

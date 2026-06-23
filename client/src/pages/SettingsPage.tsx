import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CURRENT_USER_KEY } from "@/hooks/use-current-user";
import type { Ride, User as UserType } from "@shared/schema";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { PhoneChangeModal } from "@/components/PhoneChangeModal";
import { fmtDate, fmtDistance } from "@/lib/format";
import { ArrowLeft, User, Save, Lock, Smartphone, ShieldCheck, Route as RouteIcon } from "lucide-react";

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 6) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

export function SettingsPage() {
  const toast = useToast();
  const { user, isRegistered } = useCurrentUser();
  const userId = user?.id ?? "demo";

  // Ride stats
  const ridesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides", { userId, limit: 100 }],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/rides?userId=${encodeURIComponent(userId)}&limit=100`);
      return res.json();
    },
  });
  const rides = ridesQ.data ?? [];
  const totalMeters = rides.reduce((sum, r) => sum + (r.distanceM ?? 0), 0);

  // Profile fields
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

  return (
    <div className="min-h-full bg-background" data-testid="page-settings">
      <div className="mx-auto max-w-md px-5 pt-6 pb-12">

        {/* Header with back arrow */}
        <header className="mb-6 flex items-center gap-3">
          <Link
            href="/"
            data-testid="link-settings-back"
            aria-label="На главную"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground hover-elevate shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              TakeRide
            </div>
            <h1 className="font-display text-2xl font-light leading-tight">Профиль</h1>
          </div>
        </header>

        {/* Greeting + stats hero */}
        <div className="rounded-2xl border border-card-border bg-card px-5 py-4 mb-6 flex items-center gap-4">
          <span className="flex items-center justify-center w-12 h-12 rounded-full bg-brand-sand-soft text-brand-bark shrink-0">
            <User className="w-6 h-6" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">TakeRide</p>
            <p className="font-display text-xl font-light leading-tight truncate" data-testid="text-greeting">
              {user ? `${greeting()}, ${user.name}` : greeting()}
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="rounded-2xl border border-card-border bg-card p-4 flex flex-col items-center gap-1" data-testid="stat-distance">
            <RouteIcon className="w-5 h-5 text-muted-foreground mb-1" />
            <span className="font-display text-2xl font-light tabular-nums">{fmtDistance(totalMeters)}</span>
            <span className="text-xs text-muted-foreground uppercase tracking-widest">километров</span>
          </div>
          <div className="rounded-2xl border border-card-border bg-card p-4 flex flex-col items-center gap-1" data-testid="stat-rides">
            <User className="w-5 h-5 text-muted-foreground mb-1" />
            <span className="font-display text-2xl font-light tabular-nums">{rides.length}</span>
            <span className="text-xs text-muted-foreground uppercase tracking-widest">поездок</span>
          </div>
        </div>

        {/* Edit form */}
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

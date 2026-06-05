import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import type { Ride } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useTheme } from "@/lib/theme";
import { fmtDistance } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import {
  CreditCard as CreditCardIcon, Route as RouteIcon, ShieldCheck, HelpCircle, Settings,
  ChevronRight, CreditCard, Sun, Moon, User, Smartphone, Check,
} from "lucide-react";

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 6) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

export function ProfilePage() {
  const { theme, toggle } = useTheme();
  const toast = useToast();

  // MVP payment-method state — no real card data is collected or stored.
  const [cardBound, setCardBound] = useState(false);
  const [sbpBound, setSbpBound] = useState(false);

  const ridesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides", { userId: "demo" }],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/rides?userId=demo&limit=100");
      return res.json();
    },
  });

  const rides = ridesQ.data ?? [];
  const totalMeters = rides.reduce((sum, r) => sum + (r.distanceM ?? 0), 0);

  return (
    <div className="min-h-full bg-background" data-testid="page-profile">
      <div className="mx-auto max-w-md px-5 pt-8 pb-12">
        {/* Greeting */}
        <header className="mb-7">
          <div className="flex items-center gap-3">
            <span className="flex items-center justify-center w-12 h-12 rounded-full bg-brand-sand-soft text-brand-bark">
              <User className="w-6 h-6" />
            </span>
            <div>
              <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
                BaltCircle
              </div>
              <h1
                className="font-display text-2xl font-light leading-tight"
                data-testid="text-greeting"
              >
                {greeting()}
              </h1>
            </div>
          </div>
        </header>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <Stat
            value={fmtDistance(totalMeters)}
            label="километров"
            testId="stat-distance"
          />
          <Stat
            value={String(rides.length)}
            label="поездок"
            testId="stat-rides"
          />
        </div>

        {/* Payment-methods section — replaces the old wallet. MVP/test binding
            only: no real card data is collected or stored. */}
        <section className="mb-7" data-testid="section-payment-methods">
          <div className="flex items-center gap-2 mb-3 px-1">
            <CreditCardIcon className="w-4 h-4 text-muted-foreground" />
            <h2 className="font-display text-lg font-light">Способы оплаты</h2>
          </div>
          <div className="rounded-2xl border border-card-border bg-card overflow-hidden divide-y divide-card-border">
            <PaymentMethodRow
              icon={CreditCard}
              label={cardBound ? "Карта •••• 4242 (тест)" : "Привязать карту"}
              hint={cardBound ? "MVP — тестовая привязка, без реальных данных" : "Списание после поездки"}
              bound={cardBound}
              testId="button-bind-card"
              onClick={() => {
                setCardBound((v) => !v);
                toast.toast({
                  title: cardBound ? "Карта отвязана" : "Карта привязана (тест)",
                  description: cardBound ? undefined : "MVP-привязка. Реальные данные карты не сохраняются.",
                });
              }}
            />
            <PaymentMethodRow
              icon={Smartphone}
              label="Оплата по СБП"
              hint={sbpBound ? "MVP — тестовое подключение" : "Система быстрых платежей"}
              bound={sbpBound}
              testId="button-sbp-payment"
              onClick={() => {
                setSbpBound((v) => !v);
                toast.toast({
                  title: sbpBound ? "СБП отключён" : "СБП подключён (тест)",
                  description: sbpBound ? undefined : "MVP-подключение. Реальная оплата не производится.",
                });
              }}
            />
          </div>
        </section>

        {/* Menu */}
        <nav className="rounded-2xl border border-card-border bg-card overflow-hidden divide-y divide-card-border">
          <MenuRow href="/tariffs" icon={CreditCardIcon} label="Тарифы" testId="menu-tariffs" />
          <MenuRow href="/rides" icon={RouteIcon} label="История" testId="menu-history" />
          <MenuRow href="/tariffs" icon={ShieldCheck} label="Центр безопасности" testId="menu-safety" />
          <MenuRow href="/tariffs" icon={HelpCircle} label="Помощь" testId="menu-help" />
          <MenuRow href="/tariffs" icon={Settings} label="Настройки" testId="menu-settings" />

          {/* Theme toggle lives in the profile. */}
          <button
            type="button"
            onClick={toggle}
            data-testid="button-theme-toggle"
            className="w-full flex items-center gap-3 px-4 py-4 text-left hover-elevate"
          >
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
              {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </span>
            <span className="flex-1 font-light">
              {theme === "dark" ? "Светлая тема" : "Тёмная тема"}
            </span>
            <span className="text-xs text-muted-foreground">
              {theme === "dark" ? "Вкл." : "Выкл."}
            </span>
          </button>
        </nav>

        <div className="mt-6 px-1 text-xs text-muted-foreground" data-testid="text-account">
          демо-аккаунт · demo@baltcircle.app
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, testId }: { value: string; label: string; testId: string }) {
  return (
    <div className="rounded-2xl border border-card-border bg-card p-4" data-testid={testId}>
      <div className="font-display text-2xl font-light leading-tight">{value}</div>
      <div className="text-sm text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function PaymentMethodRow({
  icon: Icon, label, hint, bound, testId, onClick,
}: {
  icon: typeof CreditCard;
  label: string;
  hint?: string;
  bound: boolean;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="w-full flex items-center gap-3 px-4 py-4 text-left hover-elevate"
    >
      <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
        <Icon className="w-5 h-5" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block font-light truncate">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground truncate">{hint}</span>}
      </span>
      {bound ? (
        <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
      ) : (
        <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
      )}
    </button>
  );
}

function MenuRow({
  href, icon: Icon, label, testId,
}: {
  href: string;
  icon: typeof CreditCard;
  label: string;
  testId: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="flex items-center gap-3 px-4 py-4 hover-elevate"
    >
      <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
        <Icon className="w-5 h-5" />
      </span>
      <span className="flex-1 font-light">{label}</span>
      <ChevronRight className="w-4 h-4 text-muted-foreground" />
    </Link>
  );
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type { Ride } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { fmtDistance } from "@/lib/format";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  CreditCard as CreditCardIcon, Route as RouteIcon, ShieldCheck, HelpCircle, Settings,
  ChevronRight, CreditCard, User, Wallet,
} from "lucide-react";

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 6) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

export function ProfilePage() {
  const { user, isStaff } = useCurrentUser();

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
                {user ? `${greeting()}, ${user.name}` : greeting()}
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

        {/* Menu */}
        <nav className="rounded-2xl border border-card-border bg-card overflow-hidden divide-y divide-card-border">
          <MenuRow href="/payment-methods" icon={Wallet} label="Способы оплаты" testId="menu-payment-methods" />
          <MenuRow href="/tariffs" icon={CreditCardIcon} label="Тарифы" testId="menu-tariffs" />
          <MenuRow href="/rides" icon={RouteIcon} label="История" testId="menu-history" />
          <MenuRow href="/safety" icon={ShieldCheck} label="Центр безопасности" testId="menu-safety" />
          <MenuRow href="/tariffs" icon={HelpCircle} label="Помощь" testId="menu-help" />
          <MenuRow href="/settings" icon={Settings} label="Настройки" testId="menu-settings" />
          {/* Operator entry point — only for operator/admin roles. */}
          {isStaff && (
            <MenuRow href="/admin" icon={ShieldCheck} label="Операторская" testId="menu-admin" />
          )}
        </nav>

        <div className="mt-6 px-1 text-xs text-muted-foreground" data-testid="text-account">
          {user ? `${user.name} · ${user.phone}` : "демо-аккаунт · demo@baltcircle.app"}
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

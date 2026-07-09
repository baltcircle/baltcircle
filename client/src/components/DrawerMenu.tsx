import { X, User, LifeBuoy, Wallet, Route, ShieldCheck, UserCircle, Shield, ChevronRight, CreditCard, Bike } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Link } from "wouter";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useState } from "react";
import type { Ride } from "@shared/schema";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface MenuItemProps {
  href: string;
  icon: React.ElementType;
  label: string;
  onClose: () => void;
}

function MenuItem({ href, icon: Icon, label }: Omit<MenuItemProps, "onClose">) {
  return (
    <Link
      href={href}
      className="flex items-center gap-4 px-2 py-3 rounded-xl text-sidebar-foreground hover:bg-black/10 transition-colors"
    >
      <Icon className="w-5 h-5 text-sidebar-foreground/70 shrink-0" />
      <span className="flex-1 text-base text-sidebar-foreground">{label}</span>
    </Link>
  );
}

const PAYMENT_BANNER_KEY = "bc.payment.banner.dismissed";

export function DrawerMenu({ open, onClose }: Props) {
  const { user, isStaff, isRegistered } = useCurrentUser();

  const userId = user?.id ?? "";
  const ridesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides", { userId, limit: 100 }],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/rides?userId=${encodeURIComponent(userId)}&limit=100`);
      return res.json();
    },
    enabled: isRegistered && !!userId,
  });

  const methodsQ = useQuery<any[]>({
    queryKey: ["/api/payment-methods"],
    enabled: isRegistered,
  });

  const rides = ridesQ.data ?? [];
  const totalKm = (rides.reduce((sum, r) => sum + (r.distanceM ?? 0), 0) / 1000).toFixed(1);
  const hasCard = (methodsQ.data?.length ?? 0) > 0;

  // sessionStorage: dismissed resets on every new browser session
  const [bannerDismissed, setBannerDismissed] = useState(
    () => sessionStorage.getItem(PAYMENT_BANNER_KEY) === "1"
  );

  const dismissBanner = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    sessionStorage.setItem(PAYMENT_BANNER_KEY, "1");
    setBannerDismissed(true);
  };

  const showBanner = isRegistered && !hasCard && !bannerDismissed;

  return (
    <>
      {/* Backdrop — НЕ покрывает safe-area зоны, чтобы Safari не тинтил
         URL bar / status bar тёмным при вычислении цвета по контенту. */}
      <div
        className={`fixed left-0 right-0 bg-black/40 z-30 transition-opacity duration-300 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        style={{
          top: "env(safe-area-inset-top)",
          bottom: "env(safe-area-inset-bottom)",
        }}
        onClick={onClose}
      />

      {/* Drawer panel — ограничен до safe-area (сверху и снизу),
       * чтобы не залезать под status bar и home-indicator. */}
      <div
        className={`fixed right-0 w-80 bg-sidebar text-sidebar-foreground shadow-2xl z-40 flex flex-col transform transition-transform duration-300 ease-in-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          top: "env(safe-area-inset-top)",
          bottom: "env(safe-area-inset-bottom)",
        }}
      >
        {/* Close button */}
        <div
          className="flex justify-end px-4 pt-4"
        >
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-black/10 transition-colors"
          >
            <X className="w-5 h-5 text-sidebar-foreground/80" />
          </button>
        </div>

        {/* User info block — кликабельный, ведёт в /settings */}
        <Link
          href="/settings"
          className="mx-4 mt-2 block rounded-2xl hover:bg-black/10 transition-colors px-2 py-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <Logo compact className="h-9 w-9 shrink-0" />
              <div className="min-w-0">
                <h2 className="text-2xl font-semibold text-sidebar-foreground leading-tight truncate">
                  {user?.name ?? "Гость"}
                </h2>
                {user?.phone && (
                  <p className="text-sm text-sidebar-foreground/70 mt-0.5">{user.phone}</p>
                )}
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-sidebar-foreground/70 shrink-0 mt-1.5" />
          </div>

          {/* Stats */}
          <div className="flex gap-6 mt-4">
            <div className="flex items-center gap-2">
              <Route className="w-7 h-7 text-primary shrink-0" strokeWidth={2.5} />
              <div>
                <p className="text-2xl font-semibold text-sidebar-foreground tabular-nums leading-none">{totalKm}</p>
                <p className="text-xs text-sidebar-foreground/70 uppercase tracking-wide mt-1">Километры</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Bike className="w-7 h-7 text-primary shrink-0" strokeWidth={2.5} />
              <div>
                <p className="text-2xl font-semibold text-sidebar-foreground tabular-nums leading-none">{rides.length}</p>
                <p className="text-xs text-sidebar-foreground/70 uppercase tracking-wide mt-1">Поездки</p>
              </div>
            </div>
          </div>
        </Link>

        {/* Payment banner — только если нет карты и не закрыт в эту сессию */}
        {showBanner && (
          <div className="mx-4 mt-3 rounded-2xl bg-black/10 border border-sidebar-foreground/15 px-4 py-3 relative">
            <button
              onClick={dismissBanner}
              className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-full hover:bg-black/10 transition-colors"
              aria-label="Закрыть"
            >
              <X className="w-4 h-4 text-sidebar-foreground/70" />
            </button>
            <div className="flex items-start gap-3 pr-6">
              <CreditCard className="w-5 h-5 text-sidebar-foreground/80 shrink-0 mt-0.5" />
              <p className="text-sm text-sidebar-foreground leading-snug">
                Добавьте способ оплаты, чтобы начать кататься
              </p>
            </div>
            <Link
              href="/payment-methods"
              className="mt-3 flex items-center justify-center w-full h-10 rounded-full bg-primary hover:opacity-90 text-primary-foreground text-sm font-medium transition-colors"
            >
              Добавить оплату
            </Link>
          </div>
        )}

        {/* Divider */}
        <div className="mx-4 mt-3 mb-2 h-px bg-sidebar-foreground/15" />

        {/* Nav items — паддинг снизу чтобы последний пункт не прилипал к краю */}
        <nav className="flex-1 overflow-y-auto px-4 pb-4">
          <MenuItem href="/payment-methods" icon={Wallet}      label="Способы оплаты" />
          <MenuItem href="/rides"           icon={Route}       label="История"         />
          <MenuItem href="/safety"          icon={ShieldCheck} label="Информация"      />
          <MenuItem href="/support"         icon={LifeBuoy}    label="Помощь"          />
          {isStaff && (
            <MenuItem href="/admin"         icon={Shield}      label="Операторская"    />
          )}
        </nav>
      </div>
    </>
  );
}

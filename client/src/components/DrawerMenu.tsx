import { LifeBuoy, Wallet, Route, ShieldCheck, Shield, ChevronRight, Bike } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Link } from "wouter";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useEffect, useRef, useState } from "react";
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

function MenuItem({
  href,
  icon: Icon,
  label,
  onClick,
}: Omit<MenuItemProps, "onClose"> & { onClick?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-4 px-2 py-3 rounded-xl text-sidebar-foreground hover:bg-black/10 transition-colors"
    >
      <Icon className="w-5 h-5 text-primary shrink-0" strokeWidth={2.25} />
      <span className="flex-1 text-base text-sidebar-foreground">{label}</span>
    </Link>
  );
}

export function DrawerMenu({ open, onClose }: Props) {
  const { user, isStaff, isRegistered } = useCurrentUser();

  // Если меню открыто уже на ПЕРВОМ рендере (восстановлено из sessionStorage
  // после T-Bank reboot на /payment-methods), не проигрываем slide-in: панель
  // должна появиться сразу открытой. Иначе пользователь видит двойную анимацию
  // (reboot смонтировал меню → анимация №1, затем возврат с оверлея → анимация №2).
  const mountedOpenRef = useRef(open);
  const [animate, setAnimate] = useState(!open);
  useEffect(() => {
    if (mountedOpenRef.current && !animate) {
      // Включаем transition через кадр — чтобы будущее закрытие анимировалось.
      const id = requestAnimationFrame(() => setAnimate(true));
      return () => cancelAnimationFrame(id);
    }
  }, [animate]);
  const transitionCls = animate ? "transition-transform duration-300 ease-in-out" : "";
  const backdropTransitionCls = animate ? "transition-opacity duration-300" : "";

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
  const totalKm = (rides.reduce((sum, r) => sum + (r.distanceM ?? 0), 0) / 1000).toFixed(1);

  return (
    <>
      {/* Backdrop — на весь экран (inset-0). Верхнюю полосу status bar
         защищает отдельный status-bar guard в AppShell (лежит поверх). */}
      <div
        className={`fixed inset-0 bg-black/40 z-30 ${backdropTransitionCls} ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Drawer panel — растянута на ВСЮ высоту экрана (top:0, bottom:0),
       * чтобы фон панели доходил до самого верха и низа без белых
       * зазоров. Контент внутри отступает от status bar через padding. */}
      <div
        className={`fixed right-0 top-0 bottom-0 w-80 bg-sidebar text-sidebar-foreground shadow-2xl z-40 flex flex-col transform ${transitionCls} ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* User info block — кликабельный, ведёт в /settings.
         * Крестик закрытия убран — меню закрывается тапом по затемнению.
         * pt поднимает профиль к верху, но не под status bar. */}
        <Link
          href="/settings"
          className="mx-4 block rounded-2xl hover:bg-black/10 transition-colors px-2 py-2"
          style={{ marginTop: "max(env(safe-area-inset-top, 0px), 24px)" }}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <Logo compact className="h-10 w-10 shrink-0" />
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

        {/* Divider */}
        <div className="mx-4 mt-3 mb-2 h-px bg-sidebar-foreground/15" />

        {/* Nav items — паддинг снизу с учётом safe-area, чтобы последний
         * пункт не уходил под панель Safari / home-indicator. */}
        <nav
          className="flex-1 overflow-y-auto px-4"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 1.5rem)" }}
        >
          <MenuItem
            href="/payment-methods"
            icon={Wallet}
            label="Способы оплаты"
            onClick={() => {
              // Запоминаем, что зашли из бургер-меню — кнопка «назад»
              // вернёт в меню даже после T-Bank reboot.
              try {
                sessionStorage.setItem("bc.pm.origin", "drawer");
              } catch {
                /* ignore */
              }
            }}
          />
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

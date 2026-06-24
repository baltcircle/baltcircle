import { X, User, LifeBuoy, Wallet, Route, ShieldCheck, UserCircle, Shield, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
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

function MenuItem({ href, icon: Icon, label, onClose }: MenuItemProps) {
  return (
    <Link
      href={href}
      onClick={onClose}
      className="flex items-center gap-4 px-2 py-3 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-800/60 transition-colors"
    >
      <Icon className="w-5 h-5 text-gray-400 dark:text-zinc-500 shrink-0" />
      <span className="flex-1 text-base text-gray-800 dark:text-zinc-100">{label}</span>
    </Link>
  );
}

export function DrawerMenu({ open, onClose }: Props) {
  const { user, isStaff, isRegistered } = useCurrentUser();

  const ridesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides/drawer-stats"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/rides?limit=200`);
      return res.json();
    },
    enabled: isRegistered,
  });

  const rides = ridesQ.data ?? [];
  const totalKm = (rides.reduce((sum, r) => sum + (r.distanceM ?? 0), 0) / 1000).toFixed(1);

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/40 z-30 transition-opacity duration-300 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        className={`fixed top-0 right-0 h-full w-80 bg-white dark:bg-zinc-900 shadow-2xl z-40 flex flex-col transform transition-transform duration-300 ease-in-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Close button */}
        <div
          className="flex justify-end px-4"
          style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
        >
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-zinc-400" />
          </button>
        </div>

        {/* User info block — кликабельный, ведёт в /settings */}
        <Link
          href="/settings"
          onClick={onClose}
          className="mx-4 mt-2 mb-5 block rounded-2xl hover:bg-gray-50 dark:hover:bg-zinc-800/60 transition-colors px-2 py-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white leading-tight truncate">
                {user?.name ?? "Гость"}
              </h2>
              {user?.phone && (
                <p className="text-sm text-gray-400 dark:text-zinc-500 mt-0.5">{user.phone}</p>
              )}
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400 dark:text-zinc-500 shrink-0 mt-1.5" />
          </div>

          {/* Stats */}
          <div className="flex gap-6 mt-4">
            <div>
              <p className="text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">{totalKm}</p>
              <p className="text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wide mt-0.5">Километры</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">{rides.length}</p>
              <p className="text-xs text-gray-400 dark:text-zinc-500 uppercase tracking-wide mt-0.5">Поездки</p>
            </div>
          </div>
        </Link>

        {/* Divider */}
        <div className="mx-4 mb-3 h-px bg-gray-100 dark:bg-zinc-800" />

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-4">
          <MenuItem href="/payment-methods" icon={Wallet}      label="Способы оплаты" onClose={onClose} />
          <MenuItem href="/rides"           icon={Route}       label="История"         onClose={onClose} />
          <MenuItem href="/safety"          icon={ShieldCheck} label="Информация"      onClose={onClose} />
          <MenuItem href="/support"         icon={LifeBuoy}    label="Помощь"          onClose={onClose} />
          <MenuItem href="/settings"        icon={UserCircle}  label="Профиль"         onClose={onClose} />
          {isStaff && (
            <MenuItem href="/admin"         icon={Shield}      label="Операторская"    onClose={onClose} />
          )}
        </nav>
      </div>
    </>
  );
}

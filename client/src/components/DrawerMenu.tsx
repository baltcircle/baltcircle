import { X, User, LifeBuoy, Sun, Moon, Wallet, Route, ShieldCheck, Settings, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { useTheme } from "@/lib/theme";

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
      className="flex items-center gap-4 px-4 py-4 border-b border-gray-100 dark:border-zinc-800 last:border-0 hover:bg-gray-50 dark:hover:bg-zinc-800/60 transition-colors"
    >
      <span className="w-9 h-9 rounded-full bg-gray-100 dark:bg-zinc-800 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-gray-500 dark:text-zinc-400" />
      </span>
      <span className="flex-1 text-base text-gray-800 dark:text-zinc-100">{label}</span>
      <ChevronRight className="w-4 h-4 text-gray-400 dark:text-zinc-600 shrink-0" />
    </Link>
  );
}

export function DrawerMenu({ open, onClose }: Props) {
  const { theme, toggle } = useTheme();
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
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 pb-4 border-b border-gray-100 dark:border-zinc-800"
          style={{ paddingTop: "max(1.5rem, env(safe-area-inset-top))" }}
        >
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-full bg-gray-100 dark:bg-zinc-800 flex items-center justify-center">
              <User className="w-5 h-5 text-gray-500 dark:text-zinc-400" />
            </span>
            <span className="text-base font-semibold text-gray-900 dark:text-white">Профиль</span>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-zinc-400" />
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto">
          <div className="mx-4 my-4 rounded-2xl border border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            <MenuItem href="/payment-methods" icon={Wallet}      label="Способы оплаты" onClose={onClose} />
            <MenuItem href="/rides"           icon={Route}       label="История"         onClose={onClose} />
            <MenuItem href="/safety"          icon={ShieldCheck} label="Информация"      onClose={onClose} />
            <MenuItem href="/support"         icon={LifeBuoy}    label="Помощь"          onClose={onClose} />
            <MenuItem href="/settings"        icon={Settings}    label="Настройки"       onClose={onClose} />
          </div>
        </nav>

        {/* Footer — theme toggle */}
        <div
          className="px-4 pb-4 border-t border-gray-100 dark:border-zinc-800 pt-3"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <button
            onClick={() => { toggle(); onClose(); }}
            className="w-full flex items-center gap-4 px-4 py-3 rounded-2xl border border-gray-100 dark:border-zinc-800 hover:bg-gray-50 dark:hover:bg-zinc-800/60 transition-colors text-left"
          >
            <span className="w-9 h-9 rounded-full bg-gray-100 dark:bg-zinc-800 flex items-center justify-center shrink-0">
              {theme === "dark"
                ? <Sun className="w-4 h-4 text-gray-500 dark:text-zinc-400" />
                : <Moon className="w-4 h-4 text-gray-500 dark:text-zinc-400" />}
            </span>
            <span className="flex-1 text-base text-gray-800 dark:text-zinc-100">
              {theme === "dark" ? "Светлая тема" : "Тёмная тема"}
            </span>
          </button>
        </div>
      </div>
    </>
  );
}

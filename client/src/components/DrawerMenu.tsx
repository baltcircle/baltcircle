import { X, User, LifeBuoy, Sun, Moon, CreditCard } from "lucide-react";
import { Link } from "wouter";
import { useTheme } from "@/lib/theme";

interface Props {
  open: boolean;
  onClose: () => void;
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
        className={`fixed top-0 right-0 h-full w-72 bg-white dark:bg-zinc-900 shadow-2xl z-40 flex flex-col transform transition-transform duration-300 ease-in-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div
          className="flex items-center justify-between px-5 pb-4 border-b border-gray-100 dark:border-zinc-800"
          style={{ paddingTop: "max(1.5rem, env(safe-area-inset-top))" }}
        >
          <span className="text-lg font-semibold text-gray-900 dark:text-white">Меню</span>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-zinc-400" />
          </button>
        </div>
        <nav className="px-4 py-4 flex flex-col gap-1 flex-1">
          <Link
            href="/profile"
            onClick={onClose}
            className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-200 transition-colors"
          >
            <User className="w-5 h-5 text-gray-400 dark:text-zinc-500" />
            Профиль
          </Link>
          <Link
            href="/profile/payments"
            onClick={onClose}
            className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-200 transition-colors"
          >
            <CreditCard className="w-5 h-5 text-gray-400 dark:text-zinc-500" />
            Оплата
          </Link>
          <Link
            href="/support"
            onClick={onClose}
            className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-200 transition-colors"
          >
            <LifeBuoy className="w-5 h-5 text-gray-400 dark:text-zinc-500" />
            Поддержка
          </Link>
          <button
            onClick={() => { toggle(); onClose(); }}
            className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 dark:hover:bg-zinc-800 text-gray-700 dark:text-zinc-200 transition-colors w-full text-left"
          >
            {theme === "dark"
              ? <Sun className="w-5 h-5 text-gray-400 dark:text-zinc-500" />
              : <Moon className="w-5 h-5 text-gray-400 dark:text-zinc-500" />}
            {theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          </button>
        </nav>
      </div>
    </>
  );
}

import { Sun, Moon } from "lucide-react";
import type { ThemeMode } from "@/lib/theme";

export function ThemeSection({ mode, setMode }: { mode: ThemeMode; setMode: (m: ThemeMode) => void }) {
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 overflow-hidden shrink-0">
      <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Настройки приложения</p>
      <div className="px-4 py-3">
        <p className="text-base font-semibold text-gray-900 dark:text-white mb-3">Тема приложения</p>
        <div className="flex rounded-full bg-muted p-1 gap-1">
          {(["system", "light", "dark"] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 flex items-center justify-center h-8 rounded-full text-sm font-medium transition-all ${
                  active
                    ? "bg-primary text-primary-foreground shadow"
                    : "text-muted-foreground"
                }`}
              >
                {m === "system" && "Авто"}
                {m === "light" && <Sun className="w-4 h-4" />}
                {m === "dark" && <Moon className="w-4 h-4" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

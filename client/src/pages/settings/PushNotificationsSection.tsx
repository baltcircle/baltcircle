import { Bell } from "lucide-react";
import { pushStateLabel, type PushState } from "@/lib/push";

export function PushNotificationsSection({
  pushState, pushOn, pushBusy, pushDisabled, onToggle,
}: {
  pushState: PushState;
  pushOn: boolean;
  pushBusy: boolean;
  pushDisabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-800 overflow-hidden shrink-0">
      <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-widest text-gray-400 dark:text-zinc-500">Уведомления</p>
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Bell className="w-5 h-5 text-gray-400 dark:text-zinc-500 shrink-0" />
          <div className="min-w-0">
            <p className="text-base font-semibold text-gray-900 dark:text-white">Push уведомления</p>
            <p className="text-xs text-gray-400 dark:text-zinc-500 mt-0.5 truncate">
              {pushStateLabel(pushState)}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-checked={pushOn}
          role="switch"
          disabled={pushDisabled && pushState !== "ios-need-standalone" && pushState !== "denied"}
          className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${
            pushOn ? "bg-primary" : "bg-gray-200 dark:bg-zinc-600"
          } ${pushBusy ? "opacity-60" : ""} ${pushState === "unsupported" ? "opacity-40 cursor-not-allowed" : ""}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
              pushOn ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

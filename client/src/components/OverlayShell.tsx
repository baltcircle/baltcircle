/**
 * OverlayShell — wrapper for all customer pages that slide up over the map.
 * Provides: opaque full-screen background, sticky header with back button,
 * scrollable content area. Matches the look of SettingsPage.
 *
 * Usage:
 *   <OverlayShell title="Способы оплаты">
 *     <YourPageContent />
 *   </OverlayShell>
 *
 * The back button dispatches "overlay:back" which OverlayRouter intercepts
 * to play the slide-down exit animation before calling history.back().
 */
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

interface OverlayShellProps {
  title: string;
  /** Optional subtitle shown below the title in muted style */
  subtitle?: string;
  children: ReactNode;
}

export function OverlayShell({ title, subtitle, children }: OverlayShellProps) {
  return (
    <div
      className="flex flex-col bg-gray-50 dark:bg-zinc-900"
      style={{ height: "var(--app-height, 100svh)" }}
    >
      {/* Header */}
      <div
        className="relative flex items-center justify-center shrink-0 border-b border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900"
        style={{ paddingTop: "env(safe-area-inset-top)", minHeight: "calc(3.5rem + env(safe-area-inset-top))" }}
      >
        <button
          onClick={() => window.dispatchEvent(new Event("overlay:back"))}
          className="absolute left-4 flex items-center justify-center w-9 h-9 rounded-full hover:bg-gray-200 dark:hover:bg-zinc-800 transition-colors"
          style={{ top: "calc(env(safe-area-inset-top) + 0.625rem)" }}
          aria-label="Назад"
        >
          <ArrowLeft className="w-5 h-5 text-gray-700 dark:text-zinc-300" />
        </button>
        <div className="text-center" style={{ marginTop: "env(safe-area-inset-top)" }}>
          <h1 className="text-base font-semibold text-gray-900 dark:text-zinc-100">{title}</h1>
          {subtitle && (
            <p className="text-xs text-gray-500 dark:text-zinc-400 mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

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
    // Высота задаётся родительским AppShell (через --visible-height),
    // бьём на 100% этой высоты, чтобы контент не уходил под URL-бар.
    <div className="flex flex-col bg-background text-foreground h-full">
      {/* Header — верхний отступ учитывает safe-area ПЛЮС запас под голубой
           status-bar guard, чтобы заголовок не прятался под шторку. */}
      <div
        className="relative flex items-center justify-center shrink-0 border-b border-border bg-background"
        style={{
          // safe-area отталкивает шапку от шторки; дальше симметричный
          // внутренний отступ сверху/снизу, items-center центрирует текст.
          paddingTop: "calc(env(safe-area-inset-top) + 1rem)",
          paddingBottom: "1rem",
        }}
      >
        <button
          onClick={() => window.dispatchEvent(new Event("overlay:back"))}
          className="absolute left-4 flex items-center justify-center w-9 h-9 rounded-full hover:bg-muted transition-colors"
          style={{ top: "calc(env(safe-area-inset-top) + 1rem)", bottom: "1rem", marginTop: "auto", marginBottom: "auto", height: "2.25rem" }}
          aria-label="Назад"
        >
          <ArrowLeft className="w-5 h-5 text-foreground" />
        </button>
        <div className="text-center">
          <h1 className="text-base font-semibold text-foreground">{title}</h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
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

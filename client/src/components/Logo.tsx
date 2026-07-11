/**
 * TakeRide logo (v2 — new continuous-line bicycle mark)
 * — mark берётся из /brand/logo-mark.png (нави-линии на прозрачном фоне)
 * — compact: только велосипед
 */
import logoMark from "@/assets/logo-mark.png";

export function Logo({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <span
        className={
          "inline-flex items-center justify-center rounded-full bg-primary shrink-0 " +
          className
        }
        data-testid="logo-mark"
      >
        <img
          src={logoMark}
          alt="TakeRide"
          className="h-[70%] w-[70%] object-contain"
          draggable={false}
        />
      </span>
    );
  }
  return (
    <div className={"flex items-center gap-3 " + className} data-testid="logo-full">
      <span className="inline-flex items-center justify-center rounded-full bg-primary h-10 w-10 shrink-0">
        <img
          src={logoMark}
          alt="TakeRide"
          className="h-[70%] w-[70%] object-contain"
          draggable={false}
        />
      </span>
      <div className="flex flex-col leading-none">
        <span className="text-[10px] uppercase tracking-[0.32em] text-current/70 font-light">Take</span>
        <span className="font-display text-lg font-light tracking-tight">Ride</span>
      </div>
    </div>
  );
}

/** Decorative wave separator used on hero panels.
 *  Sea on top, sand on bottom by default — pass invert for opposite. */
export function BrandWave({ className = "", invert = false }: { className?: string; invert?: boolean }) {
  return (
    <svg viewBox="0 0 1200 60" preserveAspectRatio="none" className={className} aria-hidden="true">
      <path
        d={invert
          ? "M0 60 V20 C200 60 400 -10 600 20 S1000 60 1200 20 V60 Z"
          : "M0 0 V40 C200 0 400 70 600 40 S1000 0 1200 40 V0 Z"}
        fill="currentColor"
      />
    </svg>
  );
}

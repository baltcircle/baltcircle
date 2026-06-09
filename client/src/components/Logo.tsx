/**
 * TakeRide logo
 * — open circle with thin-line bicycle and a soft wave under the wordmark
 * — uses currentColor for line work, accepts "compact" (mark only)
 */
export function Logo({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  if (compact) {
    return (
      <svg viewBox="0 0 48 48" className={className} aria-label="TakeRide" data-testid="logo-mark">
        <circle cx="24" cy="24" r="22" fill="hsl(var(--brand-sea))" />
        <g stroke="hsl(var(--brand-foam))" strokeWidth="1.4" fill="none" strokeLinecap="round">
          {/* open ring */}
          <path d="M40 24a16 16 0 1 1-9.6-14.6" />
          {/* bicycle */}
          <circle cx="18" cy="30" r="5" strokeWidth="1.3" />
          <circle cx="32" cy="30" r="5" strokeWidth="1.3" />
          <path d="M18 30 L24 19 L32 30 M21 19 H27 M32 30 L28 19 L25 19" strokeLinejoin="round" />
          <circle cx="24" cy="19" r="0.8" fill="hsl(var(--brand-foam))" stroke="none" />
        </g>
      </svg>
    );
  }
  return (
    <div className={"flex items-center gap-3 " + className} data-testid="logo-full">
      <svg viewBox="0 0 48 48" className="w-9 h-9 shrink-0">
        <circle cx="24" cy="24" r="22" fill="hsl(var(--brand-sea))" />
        <g stroke="hsl(var(--brand-foam))" strokeWidth="1.4" fill="none" strokeLinecap="round">
          <path d="M40 24a16 16 0 1 1-9.6-14.6" />
          <circle cx="18" cy="30" r="5" strokeWidth="1.3" />
          <circle cx="32" cy="30" r="5" strokeWidth="1.3" />
          <path d="M18 30 L24 19 L32 30 M21 19 H27 M32 30 L28 19 L25 19" strokeLinejoin="round" />
          <circle cx="24" cy="19" r="0.8" fill="hsl(var(--brand-foam))" stroke="none" />
        </g>
      </svg>
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

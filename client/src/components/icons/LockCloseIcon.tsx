/**
 * Схематичная иллюстрация закрытия велозамка OMNI: дужка, закреплённая справа,
 * приподнята и раскрыта слева (открытое положение) — стрелка показывает, что
 * её нужно опустить рукой вниз до щелчка. Используется вместо иконки замка в
 * AwaitingLockCloseDialog — минималистичная линия в фирменном голубом цвете.
 */
export function LockCloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden="true">
      {/* корпус замка */}
      <rect x="16" y="26" width="20" height="15" rx="4" stroke="currentColor" strokeWidth="3.2" />
      {/* дужка: жёстко закреплена справа, слева приподнята (открыта) */}
      <path
        d="M32 26c0-8-16-8-16-3"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      {/* точка, куда должна встать дужка при закрытии */}
      <circle cx="16" cy="26" r="1.8" fill="currentColor" />
      {/* стрелка вниз — направление движения рукой до щелчка */}
      <line x1="8" y1="15" x2="8" y2="24" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M4.5 19.5 8 25 11.5 19.5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

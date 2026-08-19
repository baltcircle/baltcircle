import { Badge } from "@/components/ui/badge";

/* ---------------- presentational helpers ---------------- */

const TONE_TEXT: Record<string, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  sky: "text-sky-600 dark:text-sky-400",
  rose: "text-rose-600 dark:text-rose-400",
  amber: "text-amber-600 dark:text-amber-400",
};

const CHIP_TONE: Record<string, string> = {
  emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  sky: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  rose: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  muted: "bg-muted text-muted-foreground",
};

export function StatusChip({ tone, icon, label, value, testId }: {
  tone: string; icon: React.ReactNode; label: string; value: number; testId: string;
}) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 ${CHIP_TONE[tone] ?? CHIP_TONE.muted}`} data-testid={testId}>
      {icon}
      <div className="leading-tight">
        <div className="font-display text-lg font-light">{value}</div>
        <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      </div>
    </div>
  );
}

export function SummaryRow({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono font-medium ${tone ? TONE_TEXT[tone] : ""}`}>{value}</span>
    </div>
  );
}

export function RideStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "Активна", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" },
    completed: { label: "Завершена", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" },
    cancelled: { label: "Отменена", cls: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200" },
  };
  const s = map[status] ?? map.cancelled;
  return <Badge className={`${s.cls} border-0 hidden sm:inline-flex`}>{s.label}</Badge>;
}

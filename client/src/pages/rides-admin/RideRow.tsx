import type { AdminRide } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { Activity, StopCircle } from "lucide-react";
import { fmtDate, fmtRub, fmtDuration, fmtTariff } from "@/lib/format";

export function RideRowItem({ r, onEnd, busy }: { r: AdminRide; onEnd: () => void; busy: boolean }) {
  const active = r.status === "active";
  // Hourly prepaid model: the ride cost is fixed at start (tariff price paid up
  // front, in kopecks), so no live per-minute estimate is needed.
  const elapsedMs = (r.endedAt ?? Date.now()) - r.startedAt;

  return (
    <TableRow data-testid={`ride-row-${r.id}`} className={active ? "" : "opacity-90"}>
      <TableCell>
        <div className="font-medium">{r.userName ?? "—"}</div>
        <div className="text-xs text-muted-foreground font-mono">{r.userPhone ?? r.userId.slice(0, 8)}</div>
      </TableCell>
      <TableCell className="font-mono text-sm">{r.bikeId}</TableCell>
      <TableCell className="text-sm">{fmtTariff(r.tariff)}</TableCell>
      <TableCell className="text-sm">{fmtDate(r.startedAt)}</TableCell>
      <TableCell className="text-sm">{fmtDuration(elapsedMs)}</TableCell>
      <TableCell className="text-right font-mono text-sm">
        {fmtRub(r.cost)}
      </TableCell>
      <TableCell><RideStatusBadge status={r.status} /></TableCell>
      <TableCell className="text-right">
        {active && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onEnd}
            data-testid={`button-admin-end-ride-${r.id}`}
            className="text-destructive border-destructive/40 hover:text-destructive"
          >
            <StopCircle className="w-3.5 h-3.5 mr-1" />Завершить
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function RideStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "Активна", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" },
    completed: { label: "Завершена", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" },
    cancelled: { label: "Отменена", cls: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200" },
  };
  const s = map[status] ?? map.cancelled;
  return (
    <Badge className={`${s.cls} border-0`}>
      {status === "active" && <Activity className="w-3 h-3 mr-1" />}
      {s.label}
    </Badge>
  );
}

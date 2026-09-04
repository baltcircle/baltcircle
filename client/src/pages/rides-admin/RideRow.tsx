import type { AdminRide } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { StopCircle, FlaskConical } from "lucide-react";
import { fmtDate, fmtRub, fmtDuration, fmtRideTariff, fmtRideRating } from "@/lib/format";

export function RideRowItem({ r, onEnd, busy }: { r: AdminRide; onEnd: () => void; busy: boolean }) {
  const active = r.status === "active";
  // Hourly prepaid model: the ride cost is fixed at start (tariff price paid up
  // front, in kopecks), so no live per-minute estimate is needed.
  const elapsedMs = (r.endedAt ?? Date.now()) - r.startedAt;

  return (
    <TableRow data-testid={`ride-row-${r.id}`} className={active ? "" : "opacity-90"}>
      <TableCell className="text-center">
        <div className="font-medium flex items-center justify-center gap-1.5">
          {r.userName ?? "—"}
          {r.isTest && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 gap-0.5 text-amber-600 dark:text-amber-400 border-amber-500/40">
              <FlaskConical className="w-2.5 h-2.5" />Тест
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground font-mono">{r.userPhone ?? r.userId.slice(0, 8)}</div>
      </TableCell>
      <TableCell className="font-mono text-sm text-center">{r.bikeId}</TableCell>
      <TableCell className="text-sm text-center">{fmtRideTariff(r)}</TableCell>
      <TableCell className="text-sm text-center">{fmtDate(r.startedAt)}</TableCell>
      <TableCell className="text-sm text-center">{fmtDuration(elapsedMs)}</TableCell>
      <TableCell className="text-sm text-center">{fmtRideRating(r.rating)}</TableCell>
      <TableCell className="text-center font-mono text-sm">
        {fmtRub(r.cost)}
      </TableCell>
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

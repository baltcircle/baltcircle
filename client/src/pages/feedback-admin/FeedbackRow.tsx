import type { AdminRideFeedback } from "@shared/schema";
import { TableCell, TableRow } from "@/components/ui/table";
import { fmtDate } from "@/lib/format";
import { formatFeedbackReasons } from "@shared/feedback";

export function FeedbackRowItem({ f }: { f: AdminRideFeedback }) {
  const reasonLabels = formatFeedbackReasons(f.rating, f.reasons);
  const rating = f.rating;
  return (
    <TableRow data-testid={`feedback-row-${f.id}`}>
      <TableCell className="text-center">
        <div className="font-medium">{f.userName ?? "—"}</div>
        <div className="text-xs text-muted-foreground font-mono">{f.userPhone ?? f.userId.slice(0, 8)}</div>
      </TableCell>
      <TableCell className="font-mono text-sm text-center">{f.bikeId ?? "—"}</TableCell>
      <TableCell className="text-center text-sm font-mono" data-testid={`feedback-rating-${f.id}`}><span>{rating}</span></TableCell>
      <TableCell className="text-sm text-center">
        {reasonLabels.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            {reasonLabels.map((label, i) => <span key={i}>{label}</span>)}
          </div>
        )}
      </TableCell>
      <TableCell className="text-sm text-center max-w-xs">
        {f.comment ? f.comment : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-sm text-center whitespace-nowrap">{fmtDate(f.createdAt)}</TableCell>
    </TableRow>
  );
}

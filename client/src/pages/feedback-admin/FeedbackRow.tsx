import type { AdminRideFeedback } from "@shared/schema";
import { TableCell, TableRow } from "@/components/ui/table";
import { Star } from "lucide-react";
import { fmtDate } from "@/lib/format";
import { formatFeedbackReasons } from "@shared/feedback";

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5" data-testid={`feedback-stars-${rating}`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={i < rating ? "w-3.5 h-3.5 fill-amber-400 text-amber-400" : "w-3.5 h-3.5 text-muted-foreground/30"}
        />
      ))}
      <span className="ml-1 text-sm font-mono">{rating}/5</span>
    </div>
  );
}

export function FeedbackRowItem({ f }: { f: AdminRideFeedback }) {
  const reasonLabels = formatFeedbackReasons(f.rating, f.reasons);
  return (
    <TableRow data-testid={`feedback-row-${f.id}`}>
      <TableCell>
        <div className="font-medium">{f.userName ?? "—"}</div>
        <div className="text-xs text-muted-foreground font-mono">{f.userPhone ?? f.userId.slice(0, 8)}</div>
      </TableCell>
      <TableCell className="font-mono text-sm">{f.bikeId ?? "—"}</TableCell>
      <TableCell><StarRating rating={f.rating} /></TableCell>
      <TableCell className="text-sm">
        {reasonLabels.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            {reasonLabels.map((label, i) => <span key={i}>{label}</span>)}
          </div>
        )}
      </TableCell>
      <TableCell className="text-sm max-w-xs">
        {f.comment ? f.comment : <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-sm whitespace-nowrap">{fmtDate(f.createdAt)}</TableCell>
    </TableRow>
  );
}

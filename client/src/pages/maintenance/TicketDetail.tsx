import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { TicketComment, TicketWithComments } from "@shared/schema";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { errorMessage } from "@/lib/error-message";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { MessageSquarePlus, X } from "lucide-react";
import { fmtRelative } from "@/lib/format";
import { KIND_LABEL, PRIORITY_LABEL, STATUS_LABEL, normStatus, isClosed } from "./labels";

export function TicketDetail({ id, onClose, toast }: {
  id: number | null;
  onClose: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const detailQ = useQuery<TicketWithComments>({
    queryKey: [`/api/tickets/${id}`],
    enabled: id != null,
  });
  const [comment, setComment] = useState("");

  useEffect(() => { setComment(""); }, [id]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
    if (id != null) queryClient.invalidateQueries({ queryKey: [`/api/tickets/${id}`] });
  };

  const patchMut = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/tickets/${id}`, patch);
      return res.json();
    },
    onSuccess: invalidate,
    onError: (e: any) => toast.toast({ title: "Не удалось обновить", description: errorMessage(e, "Попробуйте ещё раз"), variant: "destructive" }),
  });

  const commentMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/tickets/${id}/comments`, { body: comment.trim() });
      return res.json();
    },
    onSuccess: () => { setComment(""); invalidate(); },
    onError: (e: any) => toast.toast({ title: "Не удалось добавить комментарий", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const t = detailQ.data;

  return (
    <Dialog open={id != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="dialog-ticket-detail" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display font-light">
            {t ? (t.title || KIND_LABEL[t.kind] || t.kind) : "Заявка"}
          </DialogTitle>
          <DialogDescription>
            {t ? `${t.bikeId} · ${KIND_LABEL[t.kind] ?? t.kind}` : "Загрузка…"}
          </DialogDescription>
        </DialogHeader>

        {t && (
          <div className="space-y-4">
            <div className="text-sm whitespace-pre-wrap">{t.message}</div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Статус</div>
                <Select
                  value={normStatus(t.status)}
                  onValueChange={(v) => patchMut.mutate({ status: v })}
                >
                  <SelectTrigger data-testid="select-ticket-detail-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TICKET_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Приоритет</div>
                <Select
                  value={t.priority}
                  onValueChange={(v) => patchMut.mutate({ priority: v })}
                >
                  <SelectTrigger data-testid="select-ticket-detail-priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TICKET_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>{PRIORITY_LABEL[p]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {!isClosed(t.status) && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => patchMut.mutate({ status: "closed", returnBikeToAvailable: true })}
                disabled={patchMut.isPending}
                data-testid="button-close-ticket"
              >
                <X className="w-4 h-4 mr-2" />Закрыть и вернуть велосипед в доступные
              </Button>
            )}

            {/* History / comments */}
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">История</div>
              <div className="space-y-2 max-h-56 overflow-y-auto" data-testid="ticket-history">
                {t.comments.length === 0 && <div className="text-xs text-muted-foreground">Пока пусто</div>}
                {t.comments.map((c: TicketComment) => (
                  <div key={c.id} className="text-sm" data-testid={`ticket-comment-${c.id}`}>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={c.kind === "event" ? "italic" : "font-medium not-italic text-foreground"}>{c.author}</span>
                      <span>{fmtRelative(c.createdAt)}</span>
                    </div>
                    <div className={c.kind === "event" ? "text-muted-foreground italic" : ""}>{c.body}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <Input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Добавить комментарий"
                  data-testid="input-ticket-comment"
                  onKeyDown={(e) => { if (e.key === "Enter" && comment.trim()) commentMut.mutate(); }}
                />
                <Button
                  onClick={() => commentMut.mutate()}
                  disabled={!comment.trim() || commentMut.isPending}
                  data-testid="button-add-ticket-comment"
                >
                  <MessageSquarePlus className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

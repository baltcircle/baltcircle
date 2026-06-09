import { useMemo, useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import type { Bike, Ticket, TicketComment, TicketWithComments } from "@shared/schema";
import { TICKET_KINDS, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_CLOSED_STATUSES } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Wrench, MessageSquarePlus, X } from "lucide-react";
import { fmtRelative } from "@/lib/format";

// Russian labels for the stored ids. Legacy auto-flag kinds are mapped too so
// older seeded/auto-generated tickets still render a friendly label.
const KIND_LABEL: Record<string, string> = {
  wheel_puncture: "Колесо / прокол",
  brakes: "Тормоза",
  chain: "Цепь",
  handlebar_saddle: "Руль / седло",
  lock: "Замок",
  qr_sticker: "QR-наклейка",
  dirty: "Грязный велосипед",
  lost: "Потерян / не найден",
  other: "Другое",
  // legacy
  low_battery: "Низкий заряд замка",
  suspicious_idle: "Подозрительный простой",
  repair_request: "Заявка на ремонт",
  out_of_zone: "Вне зоны",
};

const PRIORITY_LABEL: Record<string, string> = {
  low: "Низкий", medium: "Средний", high: "Высокий", critical: "Критический",
};
const PRIORITY_TONE: Record<string, string> = {
  low: "text-muted-foreground border-border",
  medium: "text-sky-600 dark:text-sky-400 border-sky-500/40",
  high: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  critical: "text-destructive border-destructive/40",
};

const STATUS_LABEL: Record<string, string> = {
  new: "Новая", open: "Новая", in_progress: "В работе",
  waiting_parts: "Ждёт запчасти", resolved: "Решена",
  closed: "Закрыта", cancelled: "Отменена",
};
const STATUS_TONE: Record<string, string> = {
  new: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  open: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  in_progress: "text-sky-600 dark:text-sky-400 border-sky-500/40",
  waiting_parts: "text-violet-600 dark:text-violet-400 border-violet-500/40",
  resolved: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40",
  closed: "text-muted-foreground border-border",
  cancelled: "text-muted-foreground border-border",
};

const normStatus = (s: string) => (s === "open" ? "new" : s);
const isClosed = (s: string) => TICKET_CLOSED_STATUSES.includes(normStatus(s));

type CreateForm = {
  bikeId: string; kind: string; priority: string; title: string; message: string; assignee: string;
};
const emptyForm: CreateForm = {
  bikeId: "", kind: "wheel_puncture", priority: "medium", title: "", message: "", assignee: "",
};

export function MaintenancePage() {
  const toast = useToast();
  const search = useSearch();
  const ticketsQ = useQuery<Ticket[]>({ queryKey: ["/api/tickets"] });
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [openOnly, setOpenOnly] = useState(false);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm);

  // Detail dialog
  const [detailId, setDetailId] = useState<number | null>(null);

  // Prefill bike id + open the create dialog when arriving from the bikes page
  // via ?bike=BC-014. Runs once per distinct query string.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const bike = params.get("bike");
    if (bike) {
      setForm((f) => ({ ...f, bikeId: bike.toUpperCase() }));
      setCreateOpen(true);
    }
  }, [search]);

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/tickets", {
        bikeId: form.bikeId.trim(),
        kind: form.kind,
        priority: form.priority,
        title: form.title.trim(),
        message: form.message.trim(),
        assignee: form.assignee.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      setCreateOpen(false);
      setForm(emptyForm);
      toast.toast({ title: "Заявка создана" });
    },
    onError: (e: any) => toast.toast({ title: "Не удалось создать заявку", description: String(e?.message ?? e), variant: "destructive" }),
  });

  const tickets = ticketsQ.data ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tickets.filter((t) => {
      if (openOnly && isClosed(t.status)) return false;
      if (statusFilter !== "all" && normStatus(t.status) !== statusFilter) return false;
      if (priorityFilter !== "all" && t.priority !== priorityFilter) return false;
      if (q) {
        const hay = `${t.bikeId} ${t.title} ${t.message} ${t.assignee ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tickets, openOnly, statusFilter, priorityFilter, query]);

  const openCount = tickets.filter((t) => !isClosed(t.status)).length;

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-maintenance">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Сервис</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Сервисные заявки</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {openCount} активных из {tickets.length}. Ремонт, неисправности, состояние парка.
          </p>
        </div>
        <Button onClick={() => { setForm(emptyForm); setCreateOpen(true); }} data-testid="button-create-ticket">
          <Plus className="w-4 h-4 mr-2" />Создать заявку
        </Button>
      </header>

      {/* Filters */}
      <Card className="p-4 mb-4" data-testid="ticket-filters">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 items-end">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Поиск</div>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Велосипед, текст, исполнитель"
              data-testid="input-ticket-search"
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Статус</div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger data-testid="select-ticket-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все статусы</SelectItem>
                {TICKET_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Приоритет</div>
            <Select value={priorityFilter} onValueChange={setPriorityFilter}>
              <SelectTrigger data-testid="select-ticket-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все приоритеты</SelectItem>
                {TICKET_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>{PRIORITY_LABEL[p]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer" data-testid="toggle-open-only">
            <Switch checked={openOnly} onCheckedChange={setOpenOnly} />
            Только активные
          </label>
        </div>
      </Card>

      {/* Ticket list */}
      <div className="space-y-2" data-testid="ticket-list">
        {ticketsQ.isLoading && <div className="text-sm text-muted-foreground py-8 text-center">Загрузка…</div>}
        {!ticketsQ.isLoading && filtered.length === 0 && (
          <div className="text-sm text-muted-foreground py-12 text-center" data-testid="tickets-empty">
            Заявок не найдено
          </div>
        )}
        {filtered.map((t) => (
          <button
            key={t.id}
            onClick={() => setDetailId(t.id)}
            className="w-full text-left"
            data-testid={`ticket-row-${t.id}`}
          >
            <Card className="p-4 hover-elevate">
              <div className="flex items-start gap-3 flex-wrap">
                <Wrench className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm">{t.bikeId}</span>
                    <span className="text-sm font-medium truncate">{t.title || KIND_LABEL[t.kind] || t.kind}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {KIND_LABEL[t.kind] ?? t.kind}
                    {t.assignee ? ` · ${t.assignee}` : ""}
                    {` · ${fmtRelative(t.createdAt)}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={PRIORITY_TONE[t.priority] ?? ""}>{PRIORITY_LABEL[t.priority] ?? t.priority}</Badge>
                  <Badge variant="outline" className={STATUS_TONE[normStatus(t.status)] ?? ""}>{STATUS_LABEL[normStatus(t.status)] ?? t.status}</Badge>
                </div>
              </div>
            </Card>
          </button>
        ))}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent data-testid="dialog-create-ticket" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display font-light">Новая сервисная заявка</DialogTitle>
            <DialogDescription>Создайте заявку на обслуживание велосипеда.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Велосипед</div>
              <Input
                value={form.bikeId}
                onChange={(e) => setForm((s) => ({ ...s, bikeId: e.target.value.toUpperCase() }))}
                placeholder="BC-014"
                list="bike-ids"
                data-testid="input-ticket-bike"
              />
              <datalist id="bike-ids">
                {(bikesQ.data ?? []).map((b) => <option key={b.id} value={b.id} />)}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Тип</div>
                <Select value={form.kind} onValueChange={(v) => setForm((s) => ({ ...s, kind: v }))}>
                  <SelectTrigger data-testid="select-ticket-kind"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TICKET_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Приоритет</div>
                <Select value={form.priority} onValueChange={(v) => setForm((s) => ({ ...s, priority: v }))}>
                  <SelectTrigger data-testid="select-ticket-priority-new"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TICKET_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>{PRIORITY_LABEL[p]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Заголовок (необязательно)</div>
              <Input
                value={form.title}
                onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))}
                placeholder="Кратко"
                data-testid="input-ticket-title"
              />
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Описание</div>
              <Textarea
                rows={3}
                value={form.message}
                onChange={(e) => setForm((s) => ({ ...s, message: e.target.value }))}
                placeholder="Что произошло?"
                data-testid="textarea-ticket-message"
              />
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Исполнитель (необязательно)</div>
              <Input
                value={form.assignee}
                onChange={(e) => setForm((s) => ({ ...s, assignee: e.target.value }))}
                placeholder="Имя механика / бригады"
                data-testid="input-ticket-assignee"
              />
            </div>
            {(form.priority === "high" || form.priority === "critical") && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Велосипед будет переведён в обслуживание (если он доступен).
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} data-testid="button-ticket-cancel">Отмена</Button>
            <Button
              onClick={() => createMut.mutate()}
              disabled={!form.bikeId.trim() || form.message.trim().length < 2 || createMut.isPending}
              data-testid="button-submit-ticket"
            >
              Создать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TicketDetail
        id={detailId}
        onClose={() => setDetailId(null)}
        toast={toast}
      />
    </div>
  );
}

function TicketDetail({ id, onClose, toast }: {
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
    onError: (e: any) => toast.toast({ title: "Не удалось обновить", description: String(e?.message ?? e), variant: "destructive" }),
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

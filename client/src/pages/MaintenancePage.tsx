import { useMemo, useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import type { Bike, Ticket, User } from "@shared/schema";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Wrench } from "lucide-react";
import { fmtRelative } from "@/lib/format";
import { TablePager, useClientPagination } from "@/components/table-pager";
import {
  KIND_LABEL, PRIORITY_LABEL, PRIORITY_TONE, STATUS_LABEL, STATUS_TONE,
  normStatus, isClosed, type CreateForm, emptyForm,
} from "./maintenance/labels";
import { CreateTicketDialog } from "./maintenance/CreateTicketDialog";
import { TicketDetail } from "./maintenance/TicketDetail";

export function MaintenancePage() {
  const toast = useToast();
  const search = useSearch();
  const ticketsQ = useQuery<Ticket[]>({ queryKey: ["/api/tickets"] });
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });
  const { canManageStaff } = useCurrentUser();
  // Staff names to suggest as assignees. Only operators/admins may read the
  // users list, so the query is gated to them; mechanics keep plain free text.
  // The input stays free text either way — this only offers autocomplete.
  const staffQ = useQuery<User[]>({ queryKey: ["/api/admin/users"], enabled: canManageStaff });
  const assigneeOptions = useMemo(
    () =>
      (staffQ.data ?? [])
        .filter((u) => u.role === "mechanic" || u.role === "operator" || u.role === "admin")
        .map((u) => u.name),
    [staffQ.data],
  );

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
  const { page, setPage, pageCount, pageItems } = useClientPagination(filtered);

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
        <div className="flex items-center gap-2">
          <Button onClick={() => { setForm(emptyForm); setCreateOpen(true); }} data-testid="button-create-ticket">
            <Plus className="w-4 h-4 mr-2" />Создать заявку
          </Button>
        </div>
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
        {pageItems.map((t) => (
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
        <TablePager page={page} pageCount={pageCount} total={filtered.length} onPage={setPage} testid="tickets-pager" />
      </div>

      <CreateTicketDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        form={form}
        setForm={setForm}
        bikes={bikesQ.data ?? []}
        assigneeOptions={assigneeOptions}
        onSubmit={() => createMut.mutate()}
        submitting={createMut.isPending}
      />

      <TicketDetail
        id={detailId}
        onClose={() => setDetailId(null)}
        toast={toast}
      />
    </div>
  );
}

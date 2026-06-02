import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Ticket, Bike } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Wrench, Battery, Clock, AlertTriangle, Plus, Check, Hourglass } from "lucide-react";
import { fmtRelative } from "@/lib/format";

const TICKET_KINDS = [
  { id: "low_battery",     label: "Низкий заряд замка",  icon: Battery },
  { id: "suspicious_idle", label: "Подозрительный простой", icon: Clock },
  { id: "repair_request",  label: "Заявка на ремонт",    icon: Wrench },
  { id: "out_of_zone",     label: "Вне зоны",            icon: AlertTriangle },
];
const STATUS_LABEL: Record<string, string> = {
  open: "Открыта", in_progress: "В работе", resolved: "Закрыта",
};

export function MaintenancePage() {
  const toast = useToast();
  const ticketsQ = useQuery<Ticket[]>({ queryKey: ["/api/tickets"] });
  const bikesQ = useQuery<Bike[]>({ queryKey: ["/api/bikes"] });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ bikeId: "", kind: "repair_request", message: "" });

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/tickets", form);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      setOpen(false);
      setForm({ bikeId: "", kind: "repair_request", message: "" });
      toast.toast({ title: "Заявка создана" });
    },
  });
  const updateMut = useMutation({
    mutationFn: async (p: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/tickets/${p.id}`, { status: p.status });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/tickets"] }),
  });

  const tickets = ticketsQ.data ?? [];
  const open_ = tickets.filter(t => t.status === "open");
  const inProgress = tickets.filter(t => t.status === "in_progress");
  const resolved = tickets.filter(t => t.status === "resolved");

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-maintenance">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Сервис</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Техобслуживание</h1>
          <p className="text-muted-foreground text-sm mt-1">Заявки на ремонт, низкий заряд замков, подозрительный простой.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-ticket"><Plus className="w-4 h-4 mr-2" />Новая заявка</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle className="font-display font-light">Новая заявка</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Велосипед</div>
                <Input
                  value={form.bikeId}
                  onChange={e => setForm(s => ({ ...s, bikeId: e.target.value.toUpperCase() }))}
                  placeholder="BC-014"
                  data-testid="input-ticket-bike"
                />
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Тип</div>
                <Select value={form.kind} onValueChange={v => setForm(s => ({ ...s, kind: v }))}>
                  <SelectTrigger data-testid="select-ticket-kind"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TICKET_KINDS.map(k => (
                      <SelectItem key={k.id} value={k.id}>{k.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Описание</div>
                <Textarea
                  rows={3}
                  value={form.message}
                  onChange={e => setForm(s => ({ ...s, message: e.target.value }))}
                  placeholder="Что произошло?"
                  data-testid="textarea-ticket-message"
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => createMut.mutate()} disabled={!form.bikeId || form.message.length < 2 || createMut.isPending} data-testid="button-submit-ticket">
                Создать
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </header>

      {/* Auto-flagged summary */}
      <div className="grid lg:grid-cols-3 gap-3 mb-6">
        <SummaryCard
          title="Низкий заряд замков"
          icon={<Battery className="w-4 h-4 text-rose-500" />}
          items={(bikesQ.data ?? []).filter(b => b.battery < 25).slice(0, 4)}
          renderBadge={b => <Badge variant="outline" className="text-rose-500 border-rose-500/40">{b.battery}%</Badge>}
        />
        <SummaryCard
          title="Простой более 60 ч"
          icon={<Clock className="w-4 h-4 text-amber-500" />}
          items={(bikesQ.data ?? []).filter(b => b.idleHours > 60).slice(0, 4)}
          renderBadge={b => <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-500/40">{b.idleHours.toFixed(0)} ч</Badge>}
        />
        <SummaryCard
          title="С пометкой «подозрительный»"
          icon={<AlertTriangle className="w-4 h-4 text-destructive" />}
          items={(bikesQ.data ?? []).filter(b => b.flagged).slice(0, 4)}
          renderBadge={() => <Badge variant="outline" className="text-destructive border-destructive/40">flag</Badge>}
        />
      </div>

      <div className="grid md:grid-cols-3 gap-3" data-testid="kanban">
        <Column title="Открыты" count={open_.length} testId="col-open" tone="warn">
          {open_.map(t => <TicketCard key={t.id} t={t} onMove={(s) => updateMut.mutate({ id: t.id, status: s })} />)}
        </Column>
        <Column title="В работе" count={inProgress.length} testId="col-progress" tone="info">
          {inProgress.map(t => <TicketCard key={t.id} t={t} onMove={(s) => updateMut.mutate({ id: t.id, status: s })} />)}
        </Column>
        <Column title="Закрыты" count={resolved.length} testId="col-resolved" tone="ok">
          {resolved.map(t => <TicketCard key={t.id} t={t} onMove={(s) => updateMut.mutate({ id: t.id, status: s })} />)}
        </Column>
      </div>
    </div>
  );
}

function SummaryCard({ title, icon, items, renderBadge }: {
  title: string; icon: React.ReactNode; items: Bike[]; renderBadge: (b: Bike) => React.ReactNode;
}) {
  return (
    <Card className="p-4" data-testid={`summary-${title}`}>
      <div className="flex items-center gap-2 text-sm font-medium">{icon} {title}</div>
      <div className="mt-3 space-y-1.5">
        {items.length === 0 && <div className="text-xs text-muted-foreground">Нет проблем</div>}
        {items.map(b => (
          <div key={b.id} className="flex items-center justify-between text-sm" data-testid={`summary-row-${b.id}`}>
            <span className="font-mono">{b.id}</span>
            {renderBadge(b)}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Column({ title, count, testId, tone, children }: {
  title: string; count: number; testId: string;
  tone: "warn" | "info" | "ok"; children: React.ReactNode;
}) {
  const dot = tone === "warn" ? "bg-amber-500" : tone === "info" ? "bg-primary" : "bg-emerald-500";
  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className={`w-2 h-2 rounded-full ${dot}`} />
          {title}
        </div>
        <Badge variant="outline">{count}</Badge>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function TicketCard({ t, onMove }: { t: Ticket; onMove: (s: string) => void }) {
  const Kind = TICKET_KINDS.find(k => k.id === t.kind) ?? TICKET_KINDS[2];
  const Icon = Kind.icon;
  return (
    <Card className="p-3" data-testid={`ticket-${t.id}`}>
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4 text-primary" />
        <span className="font-mono text-sm">{t.bikeId}</span>
        <span className="ml-auto text-xs text-muted-foreground">{fmtRelative(t.createdAt)}</span>
      </div>
      <div className="text-xs mt-2 text-muted-foreground">{Kind.label}</div>
      <div className="text-sm mt-1">{t.message}</div>
      <div className="mt-3 flex gap-2">
        {t.status !== "in_progress" && t.status !== "resolved" && (
          <Button size="sm" variant="outline" onClick={() => onMove("in_progress")} data-testid={`button-progress-${t.id}`}>
            <Hourglass className="w-3.5 h-3.5 mr-1" />В работу
          </Button>
        )}
        {t.status !== "resolved" && (
          <Button size="sm" variant="outline" onClick={() => onMove("resolved")} data-testid={`button-resolve-${t.id}`}>
            <Check className="w-3.5 h-3.5 mr-1" />Закрыть
          </Button>
        )}
        {t.status === "resolved" && (
          <Button size="sm" variant="ghost" onClick={() => onMove("open")} data-testid={`button-reopen-${t.id}`}>
            Открыть снова
          </Button>
        )}
      </div>
    </Card>
  );
}

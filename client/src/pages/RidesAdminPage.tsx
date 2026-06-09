import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { AdminRide } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Search, Activity, AlertTriangle, StopCircle } from "lucide-react";
import { fmtDate, fmtRub, fmtDuration, fmtTariff } from "@/lib/format";

const RIDES_KEY = ["/api/admin/rides"];

type RideTab = "active" | "completed" | "all";

const TABS: { id: RideTab; label: string; testId: string }[] = [
  { id: "active", label: "Активные", testId: "tab-rides-active" },
  { id: "completed", label: "Завершённые", testId: "tab-rides-completed" },
  { id: "all", label: "Все", testId: "tab-rides-all" },
];

export function RidesAdminPage() {
  const toast = useToast();
  const ridesQ = useQuery<AdminRide[]>({ queryKey: RIDES_KEY });
  const [tab, setTab] = useState<RideTab>("active");
  const [search, setSearch] = useState("");
  // The ride awaiting end confirmation (drives the alert dialog).
  const [pendingEnd, setPendingEnd] = useState<AdminRide | null>(null);

  const endMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/rides/${id}/end`, {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RIDES_KEY });
      // Fleet/active-ride state changes when a ride ends — refresh dependents.
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rides"] });
      toast.toast({ title: "Поездка завершена" });
      setPendingEnd(null);
    },
    onError: (e: Error) => {
      toast.toast({ title: "Не удалось завершить поездку", description: cleanErr(e), variant: "destructive" });
      setPendingEnd(null);
    },
  });

  const rides = ridesQ.data ?? [];

  const counts = useMemo(() => ({
    active: rides.filter((r) => r.status === "active").length,
    completed: rides.filter((r) => r.status === "completed").length,
    all: rides.length,
  }), [rides]);

  const filtered = useMemo(() => {
    const byTab = tab === "all" ? rides : rides.filter((r) => r.status === tab);
    const q = search.trim().toLowerCase();
    if (!q) return byTab;
    return byTab.filter((r) =>
      (r.userName ?? "").toLowerCase().includes(q) ||
      (r.userPhone ?? "").toLowerCase().includes(q) ||
      r.bikeId.toLowerCase().includes(q) ||
      r.userId.toLowerCase().includes(q),
    );
  }, [rides, tab, search]);

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-rides">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Операции</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Поездки</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Все аренды флота: райдер, велосипед, тариф, длительность и стоимость. Активную поездку можно завершить вручную.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Телефон, имя или код велосипеда"
            className="pl-9 w-72"
            data-testid="input-rides-search"
          />
        </div>
      </header>

      {/* ---------- Tabs / filters ---------- */}
      <div className="flex items-center gap-2 mb-4" data-testid="rides-tabs">
        {TABS.map((t) => (
          <Button
            key={t.id}
            size="sm"
            variant={tab === t.id ? "default" : "outline"}
            onClick={() => setTab(t.id)}
            data-testid={t.testId}
          >
            {t.label}
            <Badge variant="secondary" className="ml-2">{counts[t.id]}</Badge>
          </Button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {ridesQ.isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="rides-loading">
            Загрузка поездок…
          </div>
        ) : ridesQ.isError ? (
          <div className="p-10 text-center" data-testid="rides-error">
            <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-destructive" />
            <div className="text-sm text-muted-foreground mb-3">Не удалось загрузить список поездок.</div>
            <Button variant="outline" size="sm" onClick={() => ridesQ.refetch()} data-testid="button-rides-retry">
              Повторить
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="rides-empty">
            {rides.length === 0
              ? "Поездок пока нет."
              : search.trim()
                ? "Ничего не найдено по запросу."
                : "Нет поездок в этой категории."}
          </div>
        ) : (
          <Table data-testid="rides-table">
            <TableHeader>
              <TableRow>
                <TableHead>Райдер</TableHead>
                <TableHead>Велосипед</TableHead>
                <TableHead>Тариф</TableHead>
                <TableHead>Начало</TableHead>
                <TableHead>Длительность</TableHead>
                <TableHead className="text-right">Стоимость</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <RideRowItem
                  key={r.id}
                  r={r}
                  onEnd={() => setPendingEnd(r)}
                  busy={endMut.isPending}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <AlertDialog open={!!pendingEnd} onOpenChange={(o) => { if (!o) setPendingEnd(null); }}>
        <AlertDialogContent data-testid="dialog-end-ride">
          <AlertDialogHeader>
            <AlertDialogTitle>Завершить поездку?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingEnd && (
                <>
                  Поездка <span className="font-mono">{pendingEnd.bikeId}</span>
                  {pendingEnd.userName ? ` · ${pendingEnd.userName}` : ""} будет завершена,
                  велосипед освободится, а стоимость спишется с баланса райдера.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-end-ride-cancel">Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingEnd && endMut.mutate(pendingEnd.id)}
              data-testid="button-end-ride-confirm"
            >
              Завершить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RideRowItem({ r, onEnd, busy }: { r: AdminRide; onEnd: () => void; busy: boolean }) {
  const active = r.status === "active";
  // For an active ride the cost is still accruing — show a live estimate from
  // elapsed time so the table doesn't read ₽0 until the ride ends.
  const elapsedMs = (r.endedAt ?? Date.now()) - r.startedAt;
  const estCost = active && r.cost === 0
    ? Math.max(50, Math.round(50 + elapsedMs / 60000 * 6))
    : r.cost;

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
        {fmtRub(estCost)}
        {active && r.cost === 0 && <span className="text-muted-foreground"> ~</span>}
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

// apiRequest throws "<status>: <body>" — pull a human message out of the body.
function cleanErr(e: Error): string {
  const m = e.message.match(/^\d+:\s*([\s\S]*)$/);
  const body = m ? m[1] : e.message;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) return parsed.error;
  } catch {
    // body wasn't JSON; fall through
  }
  return body;
}

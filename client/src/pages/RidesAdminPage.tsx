import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { AdminRide } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Search, AlertTriangle } from "lucide-react";
import { TablePager, useClientPagination } from "@/components/table-pager";
import { RideRowItem } from "./rides-admin/RideRow";
import { cleanErr } from "@/lib/api-error";

const RIDES_KEY = ["/api/admin/rides"];

// Seed-юзеры из bootstrap.ts (populateDemoData). Скрываем их поездки из
// админ-истории, чтобы показывать только реальные аренды.
const DEMO_USER_IDS = new Set(["demo", "user-2", "user-3", "user-4", "user-5"]);

type RideTab = "active" | "completed";

const TABS: { id: RideTab; label: string; testId: string }[] = [
  { id: "active", label: "Активные", testId: "tab-rides-active" },
  { id: "completed", label: "Завершённые", testId: "tab-rides-completed" },
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

  // Отменённые поездки никогда не попадают в админ-историю поездок —
  // включены только активные и завершённые.
  const rides = useMemo(
    () => (ridesQ.data ?? []).filter((r) => !DEMO_USER_IDS.has(r.userId) && r.status !== "cancelled"),
    [ridesQ.data],
  );

  const counts = useMemo(() => ({
    active: rides.filter((r) => r.status === "active").length,
    completed: rides.filter((r) => r.status === "completed").length,
  }), [rides]);

  const filtered = useMemo(() => {
    const byTab = rides.filter((r) => r.status === tab);
    const q = search.trim().toLowerCase();
    if (!q) return byTab;
    return byTab.filter((r) =>
      (r.userName ?? "").toLowerCase().includes(q) ||
      (r.userPhone ?? "").toLowerCase().includes(q) ||
      r.bikeId.toLowerCase().includes(q) ||
      r.userId.toLowerCase().includes(q),
    );
  }, [rides, tab, search]);

  const { page, setPage, pageCount, pageItems } = useClientPagination(filtered);

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
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((r) => (
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
        <TablePager page={page} pageCount={pageCount} total={filtered.length} onPage={setPage} testid="rides-pager" />
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

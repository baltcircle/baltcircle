import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
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
import { TablePager } from "@/components/table-pager";
import { useAdminPage } from "@/hooks/use-admin-page";
import { useClock } from "@/hooks/use-clock";
import { RideRowItem } from "./rides-admin/RideRow";
import { cleanErr } from "@/lib/api-error";
import { useFleetStream } from "@/hooks/use-fleet-stream";

const RIDES_KEY = ["/api/admin/rides"];

type RideTab = "active" | "completed";

const TABS: { id: RideTab; label: string; testId: string }[] = [
  { id: "active", label: "Активные", testId: "tab-rides-active" },
  { id: "completed", label: "Завершённые", testId: "tab-rides-completed" },
];

export function RidesAdminPage() {
  const toast = useToast();
  useFleetStream();
  const [tab, setTab] = useState<RideTab>("active");
  const [search, setSearch] = useState("");
  const { query: ridesQ, page, setPage, pageCount, pageItems, total } =
    useAdminPage<AdminRide>(RIDES_KEY[0], { status: tab, search });
  const now = useClock(1000, tab === "active");
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

  const counts = ridesQ.data?.counts ?? { active: 0, completed: 0 };

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-rides">
      <h1 className="font-display text-2xl lg:text-3xl font-light mb-6 text-center">Поездки</h1>

      {/* ---------- Tabs / filters ---------- */}
      <div className="flex items-center justify-between flex-wrap gap-4 mb-2">
        <div className="flex items-center gap-2" data-testid="rides-tabs">
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
        ) : total === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="rides-empty">
            {(counts.active + counts.completed) === 0 && !search.trim()
              ? "Поездок пока нет."
              : search.trim()
                ? "Ничего не найдено по запросу."
                : "Нет поездок в этой категории."}
          </div>
        ) : (
          <Table data-testid="rides-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Райдер</TableHead>
                <TableHead className="text-center">Велосипед</TableHead>
                <TableHead className="text-center">Тариф</TableHead>
                <TableHead className="text-center">Начало</TableHead>
                <TableHead className="text-center">Длительность</TableHead>
                <TableHead className="text-center">Оценка</TableHead>
                <TableHead className="text-center">Стоимость</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((r) => (
                <RideRowItem
                  key={r.id}
                  r={r}
                  now={now}
                  onEnd={() => setPendingEnd(r)}
                  busy={endMut.isPending}
                />
              ))}
            </TableBody>
          </Table>
        )}
        <TablePager page={page} pageCount={pageCount} total={total} onPage={setPage} testid="rides-pager" />
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

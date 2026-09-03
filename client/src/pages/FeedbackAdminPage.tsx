import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { AdminRideFeedback } from "@shared/schema";
import { formatFeedbackReasons } from "@shared/feedback";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search, AlertTriangle, ArrowUp, ArrowDown } from "lucide-react";
import { TablePager, useClientPagination } from "@/components/table-pager";
import { FeedbackRowItem } from "./feedback-admin/FeedbackRow";

const FEEDBACK_KEY = ["/api/admin/feedback"];

type SortKey = "date" | "rating" | "category";
type SortDir = "asc" | "desc";

export function FeedbackAdminPage() {
  const feedbackQ = useQuery<AdminRideFeedback[]>({ queryKey: FEEDBACK_KEY });
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const rows = feedbackQ.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((f) =>
      (f.userName ?? "").toLowerCase().includes(q) ||
      (f.userPhone ?? "").toLowerCase().includes(q) ||
      (f.bikeId ?? "").toLowerCase().includes(q) ||
      (f.comment ?? "").toLowerCase().includes(q),
    );
  }, [rows, search]);

  const sorted = useMemo(() => {
    const withKeys = filtered.map((f) => ({
      f,
      // Sort by the first formatted category label so rows with no reason
      // ("—") consistently sort to one end regardless of direction.
      categoryKey: formatFeedbackReasons(f.rating, f.reasons)[0] ?? "",
    }));
    const dir = sortDir === "asc" ? 1 : -1;
    withKeys.sort((a, b) => {
      if (sortKey === "rating") return (a.f.rating - b.f.rating) * dir;
      if (sortKey === "category") return a.categoryKey.localeCompare(b.categoryKey, "ru") * dir;
      return (a.f.createdAt - b.f.createdAt) * dir;
    });
    return withKeys.map((w) => w.f);
  }, [filtered, sortKey, sortDir]);

  const { page, setPage, pageCount, pageItems } = useClientPagination(sorted);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "date" ? "desc" : "asc");
    }
  };

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-feedback">
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Операции</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">Отзывы</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Оценки и комментарии райдеров после поездок. Сортируйте по пунктам отзыва или количеству звёзд.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Телефон, имя, велосипед или комментарий"
            className="pl-9 w-80"
            data-testid="input-feedback-search"
          />
        </div>
      </header>

      <Card className="overflow-hidden">
        {feedbackQ.isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="feedback-loading">
            Загрузка отзывов…
          </div>
        ) : feedbackQ.isError ? (
          <div className="p-10 text-center" data-testid="feedback-error">
            <AlertTriangle className="w-6 h-6 mx-auto mb-2 text-destructive" />
            <div className="text-sm text-muted-foreground mb-3">Не удалось загрузить отзывы.</div>
            <Button variant="outline" size="sm" onClick={() => feedbackQ.refetch()} data-testid="button-feedback-retry">
              Повторить
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="feedback-empty">
            {rows.length === 0 ? "Отзывов пока нет." : "Ничего не найдено по запросу."}
          </div>
        ) : (
          <Table data-testid="feedback-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Райдер</TableHead>
                <TableHead className="text-center">Велосипед</TableHead>
                <SortableHead label="Оценка" active={sortKey === "rating"} dir={sortDir} onClick={() => toggleSort("rating")} testId="sort-feedback-rating" className="justify-center" />
                <SortableHead label="Пункты" active={sortKey === "category"} dir={sortDir} onClick={() => toggleSort("category")} testId="sort-feedback-category" className="justify-center" />
                <TableHead className="text-center">Комментарий</TableHead>
                <SortableHead label="Дата" active={sortKey === "date"} dir={sortDir} onClick={() => toggleSort("date")} testId="sort-feedback-date" className="justify-center" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((f) => <FeedbackRowItem key={f.id} f={f} />)}
            </TableBody>
          </Table>
        )}
        <TablePager page={page} pageCount={pageCount} total={sorted.length} onPage={setPage} testid="feedback-pager" />
      </Card>
    </div>
  );
}

function SortableHead({ label, active, dir, onClick, testId, className }: {
  label: string; active: boolean; dir: SortDir; onClick: () => void; testId: string; className?: string;
}) {
  return (
    <TableHead>
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-1 hover:text-foreground transition-colors ${className ?? ""}`}
        data-testid={testId}
      >
        {label}
        {active && (dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </TableHead>
  );
}

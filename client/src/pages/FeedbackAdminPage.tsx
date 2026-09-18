import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { AdminFeedbackRow } from "@shared/schema";
import { formatFeedbackReasons } from "@shared/feedback";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search, AlertTriangle, ArrowUp, ArrowDown } from "lucide-react";
import { TablePager, useClientPagination } from "@/components/table-pager";
import { FeedbackRowItem } from "./feedback-admin/FeedbackRow";

const FEEDBACK_KEY = ["/api/admin/feedback"];

type SortDir = "asc" | "desc";

const RATING_OPTIONS = ["5", "4", "3", "2", "1"];

export function FeedbackAdminPage() {
  const feedbackQ = useQuery<AdminFeedbackRow[]>({ queryKey: FEEDBACK_KEY });
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [ratingFilter, setRatingFilter] = useState<string>("all");
  const [dateDir, setDateDir] = useState<SortDir>("desc");

  const rows = feedbackQ.data ?? [];

  // Every distinct "Пункты" label actually present in the loaded feedback,
  // in the same shape the table cell renders them ("Поддержка" for support
  // rows, formatted reason labels otherwise) — powers the filter dropdown
  // embedded in the column header, analogous to the Status filter on the
  // Maintenance page.
  const categoryOptions = useMemo(() => {
    const labels = new Set<string>();
    for (const f of rows) {
      if (f.kind === "support") { labels.add("Поддержка"); continue; }
      for (const label of formatFeedbackReasons(f.rating, f.reasons)) labels.add(label);
    }
    return Array.from(labels).sort((a, b) => a.localeCompare(b, "ru"));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((f) => {
      if (ratingFilter !== "all" && String(f.rating) !== ratingFilter) return false;
      if (categoryFilter !== "all") {
        const labels = f.kind === "support" ? ["Поддержка"] : formatFeedbackReasons(f.rating, f.reasons);
        if (!labels.includes(categoryFilter)) return false;
      }
      if (!q) return true;
      return (
        (f.userName ?? "").toLowerCase().includes(q) ||
        (f.userPhone ?? "").toLowerCase().includes(q) ||
        (f.bikeId ?? "").toLowerCase().includes(q) ||
        (f.comment ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, search, categoryFilter, ratingFilter]);

  const sorted = useMemo(() => {
    const dir = dateDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => (a.createdAt - b.createdAt) * dir);
  }, [filtered, dateDir]);

  const { page, setPage, pageCount, pageItems } = useClientPagination(sorted);

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-feedback">
      <h1 className="font-display text-2xl lg:text-3xl font-light mb-6 text-center">Отзывы</h1>

      <div className="flex items-center justify-end gap-4 mb-2">
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
      </div>

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
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="feedback-empty">
            Отзывов пока нет.
          </div>
        ) : (
          <Table data-testid="feedback-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Райдер</TableHead>
                <TableHead className="text-center">Велосипед</TableHead>
                <FilterSelectHead
                  value={ratingFilter}
                  onChange={setRatingFilter}
                  allLabel="Все оценки"
                  options={RATING_OPTIONS.map((r) => ({ value: r, label: r }))}
                  testId="select-feedback-rating"
                />
                <FilterSelectHead
                  value={categoryFilter}
                  onChange={setCategoryFilter}
                  allLabel="Все пункты"
                  options={categoryOptions.map((label) => ({ value: label, label }))}
                  testId="select-feedback-category"
                />
                <TableHead className="text-center">Комментарий</TableHead>
                <SortableHead label="Дата" active dir={dateDir} onClick={() => setDateDir((d) => (d === "asc" ? "desc" : "asc"))} testId="sort-feedback-date" className="justify-center" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="p-10 text-center text-sm text-muted-foreground" data-testid="feedback-empty">
                    Ничего не найдено по запросу.
                  </TableCell>
                </TableRow>
              ) : (
                pageItems.map((f) => <FeedbackRowItem key={`${f.kind}-${f.id}`} f={f} />)
              )}
            </TableBody>
          </Table>
        )}
        <TablePager page={page} pageCount={pageCount} total={sorted.length} onPage={setPage} testid="feedback-pager" />
      </Card>
    </div>
  );
}

// Table header cell whose content is a Select instead of plain text — used to
// filter directly from the column (Оценка, Пункты), one-to-one with the
// Status filter dropdown pattern used on the Maintenance page.
function FilterSelectHead({ value, onChange, allLabel, options, testId }: {
  value: string; onChange: (v: string) => void; allLabel: string;
  options: { value: string; label: string }[]; testId: string;
}) {
  return (
    <TableHead className="text-center">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-auto min-w-[7rem] mx-auto text-xs" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </TableHead>
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
        className={`flex w-full items-center gap-1 hover:text-foreground transition-colors ${className ?? ""}`}
        data-testid={testId}
      >
        {label}
        {active && (dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </TableHead>
  );
}

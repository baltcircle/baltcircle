import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const DEFAULT_PAGE_SIZE = 50;

// Client-side pagination over an already-fetched, filtered list. The admin list
// endpoints return the full set (so search, CSV export and the operations map
// keep working); this hook keeps the rendered table bounded so a large fleet or
// user base never paints thousands of rows at once. Resets to page 0 whenever
// the underlying item count changes (e.g. a search narrows the list).
export function useClientPagination<T>(items: T[], pageSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => {
    if (page > pageCount - 1) setPage(0);
  }, [pageCount, page]);
  const pageItems = useMemo(
    () => items.slice(page * pageSize, page * pageSize + pageSize),
    [items, page, pageSize],
  );
  return { page, setPage, pageCount, pageItems, pageSize };
}

export function TablePager({
  page, pageCount, total, onPage, testid,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (p: number) => void;
  testid?: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <div
      className="flex items-center justify-between px-4 py-3 border-t text-sm text-muted-foreground"
      data-testid={testid ?? "table-pager"}
    >
      <span>Стр. {page + 1} из {pageCount} · всего {total}</span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
          data-testid="button-page-prev"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />Назад
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
          data-testid="button-page-next"
        >
          Вперёд<ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}

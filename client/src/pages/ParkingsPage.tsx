import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Parking } from "@shared/schema";
import { useFleetStream } from "@/hooks/use-fleet-stream";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Plus } from "lucide-react";
import { ParkingsTable } from "./parkings/ParkingsTable";
import { ParkingFormDialog } from "./parkings/ParkingFormDialog";
import { ADMIN_PARKINGS_KEY } from "./parkings/parking-utils";

export function ParkingsPage() {
  const parkingsQ = useQuery<Parking[]>({ queryKey: ADMIN_PARKINGS_KEY });
  useFleetStream(); // «Занято» зависит от велосипедов — обновляем ливе

  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Parking | null>(null);

  const parkings = parkingsQ.data ?? [];

  // С удалением статуса из UI каждая живая (не архивная) точка всегда
  // активна — сервер гарантирует это при создании/восстановлении.
  const activeCount = parkings.filter((p) => !p.archivedAt).length;
  const archivedCount = parkings.filter((p) => p.archivedAt).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Поиск находит парковку даже если она скрыта (в архиве) —
    // скрытые остаются вне обычного списка только пока поиск пуст.
    return parkings
      .filter((p) => q || (showArchived ? !!p.archivedAt : !p.archivedAt))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.city ?? "").toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [parkings, search, showArchived]);

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (p: Parking) => {
    setEditing(p);
    setFormOpen(true);
  };

  if (parkingsQ.isLoading) {
    return (
      <div className="px-4 lg:px-10 py-10 max-w-7xl mx-auto" data-testid="parkings-loading">
        <p className="text-muted-foreground text-sm">Загрузка парковок…</p>
      </div>
    );
  }
  if (parkingsQ.isError) {
    return (
      <div className="px-4 lg:px-10 py-10 max-w-7xl mx-auto" data-testid="parkings-error">
        <p className="text-destructive text-sm">Не удалось загрузить парковки. Обновите страницу.</p>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-parkings">
      <h1 className="font-display text-2xl lg:text-3xl font-light mb-6">
        Управление парковками
      </h1>

      <div className="flex items-center justify-between flex-wrap gap-4 mb-2">
        <p className="text-muted-foreground text-sm pl-4">
          Активных: {activeCount}
          {archivedCount > 0 ? ` · ${archivedCount} в архиве` : ""}
        </p>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по названию / коду"
              className="pl-9 w-60"
              data-testid="input-parking-search"
            />
          </div>
          <Button onClick={openAdd} data-testid="button-create-parking">
            <Plus className="w-4 h-4 mr-2" /> Добавить
          </Button>
        </div>
      </div>

      {activeCount === 0 && (
        <div
          className="mb-4 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300 px-4 py-3 text-sm"
          data-testid="parkings-no-active-warning"
        >
          Нет ни одной активной парковки. Клиенты не увидят точек на карте — добавьте или восстановите парковку из архива.
        </div>
      )}

      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="block text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 mb-4"
          data-testid="button-toggle-archived-parkings"
        >
          {showArchived ? "Скрыть скрытые" : `Скрытых: ${archivedCount} · показать`}
        </button>
      )}

      <ParkingsTable
        parkings={filtered}
        search={search}
        showArchived={showArchived}
        onEdit={openEdit}
      />

      <ParkingFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        parkings={parkings}
      />
    </div>
  );
}

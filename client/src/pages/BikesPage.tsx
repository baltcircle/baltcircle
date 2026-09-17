import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Bike, Parking } from "@shared/schema";
import { useFleetStream } from "@/hooks/use-fleet-stream";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Plus } from "lucide-react";
import { BikesTable } from "./bikes/BikesTable";
import { BikeFormDialog } from "./bikes/BikeFormDialog";
import { BikeQrDialog } from "./bikes/BikeQrDialog";
import { ADMIN_BIKES_KEY, type AdminBikeRow } from "./bikes/bike-utils";

// Re-exported for the existing test suite (client/src/pages/BikesPage.test.ts
// imports pure helpers from this module path). The actual implementations now
// live in ./bikes/bike-utils.
export {
  buildBikeSavePayload,
  liveLockBatteryDisplay,
  lockPickerOptions,
  type BikeSaveForm,
  type LockBatterySnapshot,
  type LockPickerOption,
} from "./bikes/bike-utils";

export function BikesPage() {
  const toast = useToast();
  // Mechanics get a read-only fleet view: they can browse and open service
  // tickets, but fleet mutations (create/edit/archive/delete) are operator/admin
  // only. The server enforces this too — this just hides the controls.
  const { isMechanic } = useCurrentUser();
  const canWrite = !isMechanic;
  const bikesQ = useQuery<AdminBikeRow[]>({ queryKey: ADMIN_BIKES_KEY });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  useFleetStream(); // живое обновление статусов велосипедов

  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Bike | null>(null);
  const [qrBike, setQrBike] = useState<Bike | null>(null);

  const bikes = bikesQ.data ?? [];
  const parkings = parkingsQ.data ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Поиск по коду находит велосипед даже если он скрыт (в архиве) —
    // скрытые остаются вне обычного списка только пока поиск пуст.
    return bikes
      .filter((b) => q || showArchived || b.status !== "archived")
      .filter((b) => !q || b.id.toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [bikes, search, showArchived]);

  const archivedCount = bikes.filter((b) => b.status === "archived").length;

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (b: Bike) => {
    setEditing(b);
    setFormOpen(true);
  };

  if (bikesQ.isLoading) {
    return (
      <div className="px-4 lg:px-10 py-10 max-w-7xl mx-auto" data-testid="bikes-loading">
        <p className="text-muted-foreground text-sm">Загрузка флота…</p>
      </div>
    );
  }
  if (bikesQ.isError) {
    return (
      <div className="px-4 lg:px-10 py-10 max-w-7xl mx-auto" data-testid="bikes-error">
        <p className="text-destructive text-sm">Не удалось загрузить велосипеды. Обновите страницу.</p>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-10 py-6 lg:py-10 max-w-7xl mx-auto" data-testid="page-admin-bikes">
      <h1 className="font-display text-2xl lg:text-3xl font-light mb-6 text-center">
        Управление велосипедами
      </h1>

      <div className="flex items-end justify-between flex-wrap gap-4 mb-2">
        <p className="text-muted-foreground text-sm pl-4">
          Активных: {bikes.filter((b) => b.status !== "archived").length}
          {archivedCount > 0 ? ` · ${archivedCount} в архиве` : ""}
        </p>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по коду"
              className="pl-9 w-64"
              data-testid="input-bikes-search"
            />
          </div>
          {canWrite && (
            <Button onClick={openAdd} data-testid="button-add-bike">
              <Plus className="w-4 h-4 mr-2" /> Добавить
            </Button>
          )}
        </div>
      </div>

      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="block text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 mb-4"
          data-testid="button-toggle-archived"
        >
          {showArchived ? "Скрыть скрытые" : `Скрытых: ${archivedCount} · показать`}
        </button>
      )}

      <BikesTable
        bikes={filtered}
        parkings={parkings}
        canWrite={canWrite}
        search={search}
        onQr={setQrBike}
        onEdit={openEdit}
      />

      <BikeFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        canWrite={canWrite}
      />

      <BikeQrDialog
        bike={qrBike}
        onClose={() => setQrBike(null)}
        onCopied={() => toast.toast({ title: "Скопировано", description: "Ссылка QR в буфере обмена" })}
      />
    </div>
  );
}

import { Fragment, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Parking } from "@shared/schema";
import { PARKING_CITIES } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Pencil, Trash2, MapPin, RotateCcw } from "lucide-react";
import { ADMIN_PARKINGS_KEY } from "./parking-utils";

export function ParkingsTable({
  parkings, search, showArchived, onEdit,
}: {
  /** Already filtered by the page (search + archive view). */
  parkings: Parking[];
  search: string;
  showArchived: boolean;
  onEdit: (p: Parking) => void;
}) {
  const toast = useToast();

  // Группировка по городам для таблицы: города из фикс-списка идут в его
  // порядке, прочие (демо/легаси) — по алфавиту после, «Без города» — в конце.
  const grouped = useMemo(() => {
    const byCity = new Map<string, Parking[]>();
    for (const p of parkings) {
      const key = (p.city ?? "").trim() || "Без города";
      (byCity.get(key) ?? byCity.set(key, []).get(key)!).push(p);
    }
    const order = (city: string) => {
      const i = (PARKING_CITIES as readonly string[]).indexOf(city);
      if (i !== -1) return [0, i, city] as const;
      if (city === "Без города") return [2, 0, city] as const;
      return [1, 0, city] as const;
    };
    return Array.from(byCity.entries()).sort(([a], [b]) => {
      const [ga, ia, na] = order(a);
      const [gb, ib, nb] = order(b);
      return ga - gb || ia - ib || na.localeCompare(nb);
    });
  }, [parkings]);

  const restoreMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/parkings/${encodeURIComponent(id)}/restore`);
      return res.json() as Promise<Parking>;
    },
    onSuccess: (p) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_PARKINGS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/parkings"] });
      toast.toast({ title: "Парковка восстановлена", description: p.name });
    },
    onError: (err: any) => toast.toast({ title: "Не удалось", description: err?.message?.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/admin/parkings/${encodeURIComponent(id)}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_PARKINGS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/parkings"] });
      toast.toast({ title: "Парковка удалена" });
    },
    onError: (err: any) => {
      // 409 means bikes referenced it and it was archived instead.
      const archived = /^409:/.test(String(err?.message));
      queryClient.invalidateQueries({ queryKey: ADMIN_PARKINGS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/parkings"] });
      toast.toast({
        title: archived ? "Переведена в архив" : "Не удалось удалить парковку",
        description: err?.message?.replace(/^\d+:\s*/, "") ?? "Проверьте соединение и повторите попытку",
        variant: archived ? "default" : "destructive",
      });
    },
  });

  return (
    <Card className="overflow-x-auto" data-testid="table-admin-parkings">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-24 text-center">Код</TableHead>
            <TableHead className="text-center">Название</TableHead>
            <TableHead className="text-center">Занято / Вмест.</TableHead>
            <TableHead className="text-center">Действия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grouped.map(([city, rows]) => (
            <Fragment key={`grp-${city}`}>
              <TableRow className="bg-muted/50 hover:bg-muted/50" data-testid={`parking-city-group-${city}`}>
                <TableCell colSpan={4} className="py-2 text-center">
                  <span className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
                    {city}
                    <span className="font-bold normal-case tracking-normal">{rows.length}</span>
                  </span>
                </TableCell>
              </TableRow>
              {rows.map((p: Parking) => {
                const isArchived = !!p.archivedAt;
                return (
                  <TableRow
                    key={p.id}
                    data-testid={`row-admin-parking-${p.id}`}
                    className={`hover-elevate${isArchived ? " opacity-60" : ""}`}
                  >
                    <TableCell className="font-mono text-sm text-center">
                      <span className="inline-flex items-center gap-2">
                        <MapPin className="w-3.5 h-3.5 text-muted-foreground" />{p.id}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-center">
                      <div className="flex items-center justify-center gap-2">
                        {p.name}
                        {isArchived && (
                          <Badge className="bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border-0">
                            Архив
                          </Badge>
                        )}
                      </div>
                      {p.notes && <div className="text-xs text-muted-foreground truncate max-w-xs">{p.notes}</div>}
                    </TableCell>
                    <TableCell className="text-center text-sm font-mono">{p.occupied} / {p.capacity}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        {isArchived ? (
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => restoreMut.mutate(p.id)}
                            disabled={restoreMut.isPending}
                            title="Восстановить из архива"
                            data-testid="button-restore-parking"
                          >
                            <RotateCcw className="w-4 h-4 mr-1" /> Восстановить
                          </Button>
                        ) : (
                          <>
                            <Button variant="ghost" size="icon" onClick={() => onEdit(p)} title="Редактировать" data-testid={`button-edit-parking-${p.id}`}>
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              onClick={() => {
                                if (confirm(`Удалить ${p.name}? Если привязаны велосипеды — парковка уйдёт в архив.`)) {
                                  deleteMut.mutate(p.id);
                                }
                              }}
                              disabled={deleteMut.isPending}
                              title="Удалить"
                              data-testid={`button-delete-parking-${p.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </Fragment>
          ))}
          {parkings.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground py-12" data-testid="parkings-empty">
                {search
                  ? "Ничего не найдено"
                  : showArchived
                    ? "В архиве пока нет парковок."
                    : "Парковок пока нет — добавьте первую."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

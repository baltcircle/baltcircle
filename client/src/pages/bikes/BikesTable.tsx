import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { Bike, BikeStatus, Parking } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Pencil, QrCode, Archive, Trash2, Bike as BikeIcon, Wrench, FlaskConical,
} from "lucide-react";
import { Link } from "wouter";
import { TablePager, useClientPagination } from "@/components/table-pager";
import { ADMIN_BIKES_KEY, STATUS_LABEL, STATUS_TONE } from "./bike-utils";

export function BikesTable({
  bikes, parkings, canWrite, search, onQr, onEdit,
}: {
  bikes: Bike[];
  parkings: Parking[];
  canWrite: boolean;
  search: string;
  onQr: (bike: Bike) => void;
  onEdit: (bike: Bike) => void;
}) {
  const toast = useToast();
  const { isAdmin } = useCurrentUser();
  const { page, setPage, pageCount, pageItems } = useClientPagination(bikes);
  const [purgeTarget, setPurgeTarget] = useState<Bike | null>(null);
  const parkingName = (id: string | null) =>
    id ? parkings.find((p) => p.id === id)?.name ?? id : "—";

  const archiveMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/bikes/${encodeURIComponent(id)}/archive`);
      return res.json() as Promise<Bike>;
    },
    onSuccess: (bike) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_BIKES_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      toast.toast({ title: "Велосипед в архиве", description: bike.id });
    },
    onError: (err: any) => toast.toast({ title: "Не удалось", description: err?.message?.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/admin/bikes/${encodeURIComponent(id)}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_BIKES_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      toast.toast({ title: "Велосипед удалён" });
    },
    onError: (err: any) => {
      // 409 means the bike had ride history and was archived instead.
      queryClient.invalidateQueries({ queryKey: ADMIN_BIKES_KEY });
      toast.toast({
        title: "Переведён в архив",
        description: err?.message?.replace(/^\d+:\s*/, "") ?? "У велосипеда есть история поездок",
      });
    },
  });

  // Permanent purge — admin-only, only for already-archived test bikes
  // (enforced again server-side; this button is just the UI-level gate).
  const purgeMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/bikes/${encodeURIComponent(id)}/purge`);
      return res.json() as Promise<{ ok: true; deleted: Record<string, number> }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_BIKES_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      const ridesDeleted = result.deleted.rides ?? 0;
      toast.toast({
        title: "Велосипед удалён безвозвратно",
        description: `удалено поездок: ${ridesDeleted}`,
      });
      setPurgeTarget(null);
    },
    onError: (err: any) => toast.toast({
      title: "Не удалось удалить",
      description: err?.message?.replace(/^\d+:\s*/, ""),
      variant: "destructive",
    }),
  });

  return (
    <Card className="overflow-x-auto" data-testid="table-admin-bikes">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-28">Код</TableHead>
            <TableHead>Модель</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead>Замок ID</TableHead>
            <TableHead>Парковка</TableHead>
            <TableHead>Серийный</TableHead>
            <TableHead className="text-right">Действия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageItems.map((b) => (
            <TableRow key={b.id} data-testid={`row-admin-bike-${b.id}`} className="hover-elevate">
              <TableCell className="font-mono text-sm">
                <span className="inline-flex items-center gap-2">
                  <BikeIcon className="w-3.5 h-3.5 text-muted-foreground" />{b.id}
                </span>
              </TableCell>
              <TableCell className="text-sm">{b.model}</TableCell>
              <TableCell>
                <Badge className={`${STATUS_TONE[b.status as BikeStatus] ?? STATUS_TONE.offline} border-0`}>
                  {STATUS_LABEL[b.status as BikeStatus] ?? b.status}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground font-mono">{b.lockImei || "—"}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{parkingName(b.parkingId)}</TableCell>
              <TableCell className="text-sm text-muted-foreground font-mono">{b.serial || "—"}</TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="icon" onClick={() => onQr(b)} title="QR-код" data-testid={`button-qr-${b.id}`}>
                    <QrCode className="w-4 h-4" />
                  </Button>
                  {canWrite && (
                    <Button variant="ghost" size="icon" onClick={() => onEdit(b)} title="Редактировать" data-testid={`button-edit-${b.id}`}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                  )}
                  <Button asChild variant="ghost" size="icon" title="Создать сервисную заявку" data-testid={`button-service-${b.id}`}>
                    <Link href={`/admin/maintenance?bike=${encodeURIComponent(b.id)}`}>
                      <Wrench className="w-4 h-4" />
                    </Link>
                  </Button>
                  {canWrite && b.status !== "archived" && (
                    <Button
                      variant="ghost" size="icon"
                      onClick={() => archiveMut.mutate(b.id)}
                      disabled={archiveMut.isPending}
                      title="В архив"
                      data-testid={`button-archive-${b.id}`}
                    >
                      <Archive className="w-4 h-4" />
                    </Button>
                  )}
                  {canWrite && (
                    <Button
                      variant="ghost" size="icon"
                      onClick={() => {
                        if (confirm(`Удалить ${b.id}? Если есть история поездок — велосипед уйдёт в архив.`)) {
                          deleteMut.mutate(b.id);
                        }
                      }}
                      disabled={deleteMut.isPending}
                      title="Удалить"
                      data-testid={`button-delete-${b.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                  {isAdmin && b.status === "archived" && (b.isTestBike || b.seed) && (
                    <Button
                      variant="ghost" size="icon"
                      onClick={() => setPurgeTarget(b)}
                      title="Удалить безвозвратно (тестовый/демо)"
                      className="text-destructive"
                      data-testid={`button-purge-${b.id}`}
                    >
                      <FlaskConical className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
          {bikes.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground py-12" data-testid="bikes-empty">
                {search ? "Ничего не найдено" : "Велосипедов пока нет — добавьте первый."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <TablePager page={page} pageCount={pageCount} total={bikes.length} onPage={setPage} testid="bikes-pager" />

      <AlertDialog open={!!purgeTarget} onOpenChange={(open) => !open && setPurgeTarget(null)}>
        <AlertDialogContent data-testid="dialog-purge-bike">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить велосипед «{purgeTarget?.id}» безвозвратно?</AlertDialogTitle>
            <AlertDialogDescription>
              В отличие от обычного удаления, здесь вместе с велосипедом безвозвратно исчезнут все его
              поездки, заявки, заказы на оплату, резервы, алерты и история GPS-телеметрии. Действие доступно
              только для архивных тестовых или демо-сидированных велосипедов. Для тестового (не demo)
              велосипеда будет отклонено, если на него есть реальные поездки или оплата; для demo-сидированного
              — удалится всегда, так как его история синтетическая.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purgeMut.isPending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => purgeTarget && purgeMut.mutate(purgeTarget.id)}
              disabled={purgeMut.isPending}
              className="bg-destructive text-destructive-foreground border border-destructive-border hover:bg-destructive/90"
              data-testid="button-confirm-purge-bike"
            >
              {purgeMut.isPending ? "удаляем…" : "удалить безвозвратно"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

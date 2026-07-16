import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { Bike, BikeStatus, Parking } from "@shared/schema";
import { BIKE_STATUSES } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useFleetStream } from "@/hooks/use-fleet-stream";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { bikeQrLink } from "@/lib/format";
import { qrToSvg } from "@/lib/qrcode";
import { BikeQr } from "@/components/BikeQr";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Search, Plus, Pencil, QrCode, Archive, Trash2, Copy, Download, Printer, Bike as BikeIcon, Wrench,
} from "lucide-react";
import { Link } from "wouter";
import { TablePager, useClientPagination } from "@/components/table-pager";

const ADMIN_BIKES_KEY = ["/api/admin/bikes"] as const;

const STATUS_LABEL: Record<BikeStatus, string> = {
  available: "Доступен",
  rented: "В аренде",
  reserved: "Бронь",
  maintenance: "Сервис",
  offline: "Оффлайн",
  storage: "На складе",
  lost: "Утерян",
  archived: "Архив",
};

const STATUS_TONE: Record<BikeStatus, string> = {
  available: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  rented: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  reserved: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  maintenance: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  offline: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
  storage: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200",
  lost: "bg-rose-200 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  archived: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

type FormState = {
  id: string;
  model: string;
  status: BikeStatus;
  battery: string;
  serial: string;
  lockId: string;
  parkingId: string;
  notes: string;
};

const emptyForm: FormState = {
  id: "", model: "", status: "available", battery: "100",
  serial: "", lockId: "", parkingId: "", notes: "",
};

export function BikesPage() {
  const toast = useToast();
  // Mechanics get a read-only fleet view: they can browse and open service
  // tickets, but fleet mutations (create/edit/archive/delete) are operator/admin
  // only. The server enforces this too — this just hides the controls.
  const { isMechanic } = useCurrentUser();
  const canWrite = !isMechanic;
  const bikesQ = useQuery<Bike[]>({ queryKey: ADMIN_BIKES_KEY });
  const parkingsQ = useQuery<Parking[]>({ queryKey: ["/api/parkings"] });
  useFleetStream(); // живое обновление статусов велосипедов

  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Bike | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const [qrBike, setQrBike] = useState<Bike | null>(null);

  const bikes = bikesQ.data ?? [];
  const parkings = parkingsQ.data ?? [];
  const parkingName = (id: string | null) =>
    id ? parkings.find((p) => p.id === id)?.name ?? id : "—";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bikes
      .filter((b) => showArchived || b.status !== "archived")
      .filter((b) =>
        !q ||
        b.id.toLowerCase().includes(q) ||
        b.model.toLowerCase().includes(q) ||
        (b.serial ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [bikes, search, showArchived]);

  const archivedCount = bikes.filter((b) => b.status === "archived").length;
  const { page, setPage, pageCount, pageItems } = useClientPagination(filtered);

  // ---------- Mutations ----------
  const saveMut = useMutation({
    mutationFn: async (payload: { editingId: string | null; body: any }) => {
      const { editingId, body } = payload;
      const res = editingId
        ? await apiRequest("PATCH", `/api/admin/bikes/${encodeURIComponent(editingId)}`, body)
        : await apiRequest("POST", "/api/admin/bikes", body);
      return res.json() as Promise<Bike>;
    },
    onSuccess: (bike) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_BIKES_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/bikes"] });
      setFormOpen(false);
      toast.toast({ title: editing ? "Велосипед обновлён" : "Велосипед добавлен", description: bike.id });
    },
    onError: (err: any) => setFormError(err?.message?.replace(/^\d+:\s*/, "") ?? "Не удалось сохранить"),
  });

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

  // ---------- Form helpers ----------
  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormError(null);
    setFormOpen(true);
  };
  const openEdit = (b: Bike) => {
    setEditing(b);
    setForm({
      id: b.id,
      model: b.model,
      status: b.status as BikeStatus,
      battery: String(b.battery),
      serial: b.serial ?? "",
      lockId: b.lockId ?? "",
      parkingId: b.parkingId ?? "",
      notes: b.notes ?? "",
    });
    setFormError(null);
    setFormOpen(true);
  };

  const submitForm = () => {
    setFormError(null);
    const battery = Number(form.battery);
    if (!Number.isFinite(battery) || battery < 0 || battery > 100) {
      setFormError("Заряд должен быть числом 0–100");
      return;
    }
    const common = {
      model: form.model,
      status: form.status,
      battery,
      serial: form.serial,
      lockId: form.lockId,
      parkingId: form.parkingId === "none" ? "" : form.parkingId,
      notes: form.notes,
    };
    if (editing) {
      saveMut.mutate({ editingId: editing.id, body: common });
    } else {
      saveMut.mutate({ editingId: null, body: { id: form.id, ...common } });
    }
  };

  // ---------- Loading / error ----------
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
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Парк</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">
            Управление велосипедами
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {bikes.filter((b) => b.status !== "archived").length} активных
            {archivedCount > 0 ? ` · ${archivedCount} в архиве` : ""}. Добавляйте реальные
            велосипеды и печатайте QR-коды.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по коду / модели / серийному"
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
      </header>

      <div className="flex items-center gap-2 mb-4">
        <Button
          variant={showArchived ? "default" : "outline"}
          size="sm"
          onClick={() => setShowArchived((v) => !v)}
          data-testid="button-toggle-archived"
        >
          {showArchived ? "Скрыть архив" : "Показать архив"}
          {archivedCount > 0 && <span className="ml-2 opacity-70">{archivedCount}</span>}
        </Button>
      </div>

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
                <TableCell className="text-sm text-muted-foreground font-mono">{b.lockId || "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{parkingName(b.parkingId)}</TableCell>
                <TableCell className="text-sm text-muted-foreground font-mono">{b.serial || "—"}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon" onClick={() => setQrBike(b)} title="QR-код" data-testid={`button-qr-${b.id}`}>
                      <QrCode className="w-4 h-4" />
                    </Button>
                    {canWrite && (
                      <Button variant="ghost" size="icon" onClick={() => openEdit(b)} title="Редактировать" data-testid={`button-edit-${b.id}`}>
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
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-12" data-testid="bikes-empty">
                  {search ? "Ничего не найдено" : "Велосипедов пока нет — добавьте первый."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePager page={page} pageCount={pageCount} total={filtered.length} onPage={setPage} testid="bikes-pager" />
      </Card>

      {/* ---------- Add / edit dialog ---------- */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent data-testid="dialog-bike-form" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display font-light">
              {editing ? `Редактирование ${editing.id}` : "Новый велосипед"}
            </DialogTitle>
            <DialogDescription>
              {editing ? "Измените поля и сохраните." : "Заполните данные реального велосипеда."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Field label="Код / ID">
              <Input
                value={form.id}
                disabled={!!editing}
                onChange={(e) => setForm((f) => ({ ...f, id: e.target.value.toUpperCase() }))}
                placeholder="Напр. BC-006"
                data-testid="input-bike-id"
              />
            </Field>
            <Field label="Модель">
              <Input
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="Напр. BC City+"
                data-testid="input-bike-model"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Статус">
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as BikeStatus }))}>
                  <SelectTrigger data-testid="select-bike-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BIKE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s} data-testid={`status-option-${s}`}>{STATUS_LABEL[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Заряд замка, %">
                <Input
                  type="number" min={0} max={100}
                  value={form.battery}
                  onChange={(e) => setForm((f) => ({ ...f, battery: e.target.value }))}
                  data-testid="input-bike-battery"
                />
              </Field>
            </div>
            <Field label="Парковка (необязательно)">
              <Select
                value={form.parkingId || "none"}
                onValueChange={(v) => setForm((f) => ({ ...f, parkingId: v }))}
              >
                <SelectTrigger data-testid="select-bike-parking"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Не назначена</SelectItem>
                  {parkings.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Серийный № (необязательно)">
                <Input
                  value={form.serial}
                  onChange={(e) => setForm((f) => ({ ...f, serial: e.target.value }))}
                  data-testid="input-bike-serial"
                />
              </Field>
              <Field label="ID замка (placeholder)">
                <Input
                  value={form.lockId}
                  onChange={(e) => setForm((f) => ({ ...f, lockId: e.target.value }))}
                  placeholder="Без интеграции"
                  data-testid="input-bike-lock"
                />
              </Field>
            </div>
            <Field label="Заметки (необязательно)">
              <Textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                data-testid="input-bike-notes"
              />
            </Field>

            {formError && (
              <div className="text-xs text-destructive" data-testid="bike-form-error">{formError}</div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} data-testid="button-bike-cancel">
              Отмена
            </Button>
            <Button onClick={submitForm} disabled={saveMut.isPending} data-testid="button-bike-save">
              {saveMut.isPending ? "Сохранение…" : "Сохранить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- QR dialog ---------- */}
      <QrDialog
        bike={qrBike}
        onClose={() => setQrBike(null)}
        onCopied={() => toast.toast({ title: "Скопировано", description: "Ссылка QR в буфере обмена" })}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
      {children}
    </label>
  );
}

// Escape HTML metacharacters before interpolating untrusted text into a raw
// document.write() string (the QR print window). Prevents stored XSS via
// operator-controlled bike id/model (audit M10).
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}

function QrDialog({ bike, onClose, onCopied }: { bike: Bike | null; onClose: () => void; onCopied: () => void }) {
  const link = bike ? bikeQrLink(bike.id) : "";

  const download = () => {
    if (!bike) return;
    const svg = qrToSvg(link, { size: 512 });
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qr-${bike.id}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const print = () => {
    if (!bike) return;
    const svg = qrToSvg(link, { size: 320 });
    const w = window.open("", "_blank", "width=420,height=560");
    if (!w) return;
    // bike.id / bike.model are operator-controlled free text — escape before
    // interpolating into the print document so they can't inject markup (M10).
    const id = escapeHtml(bike.id);
    const model = escapeHtml(bike.model);
    w.document.write(`<!doctype html><html><head><title>QR ${id}</title>
      <style>body{font-family:sans-serif;text-align:center;padding:32px}
      h1{font-size:20px;margin:16px 0 4px}p{color:#666;margin:0;font-size:13px}</style>
      </head><body>${svg}<h1>${id}</h1><p>${model}</p>
      <script>window.onload=function(){window.print();}</script></body></html>`);
    w.document.close();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      onCopied();
    } catch {
      /* clipboard unavailable — link is still visible to copy manually */
    }
  };

  return (
    <Dialog open={!!bike} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="dialog-bike-qr">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            <QrCode className="w-5 h-5" /> QR-код {bike?.id}
          </DialogTitle>
          <DialogDescription>Распечатайте и наклейте на велосипед.</DialogDescription>
        </DialogHeader>

        {bike && (
          <div className="flex flex-col items-center gap-4">
            <BikeQr value={link} size={220} className="rounded-lg border border-card-border p-2 bg-white" testId="bike-qr-image" />
            <code className="text-xs break-all text-center text-muted-foreground" data-testid="bike-qr-link">{link}</code>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" size="sm" onClick={copy} data-testid="button-copy-qr">
                <Copy className="w-4 h-4 mr-2" /> Копировать
              </Button>
              <Button variant="outline" size="sm" onClick={download} data-testid="button-download-qr">
                <Download className="w-4 h-4 mr-2" /> Скачать QR
              </Button>
              <Button variant="outline" size="sm" onClick={print} data-testid="button-print-qr">
                <Printer className="w-4 h-4 mr-2" /> Печать QR
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

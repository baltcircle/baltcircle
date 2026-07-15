import { Fragment, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { Parking, ParkingStatus } from "@shared/schema";
import { PARKING_CITIES } from "@shared/schema";
import { realToMap, mapToReal } from "@shared/geo";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useFleetStream } from "@/hooks/use-fleet-stream";
import { useToast } from "@/hooks/use-toast";
import { MapLibreMap } from "@/components/MapLibreMap";
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
  Search, Plus, Pencil, Archive, Trash2, MapPin, RotateCcw,
} from "lucide-react";

const ADMIN_PARKINGS_KEY = ["/api/admin/parkings"] as const;

const STATUS_LABEL: Record<ParkingStatus, string> = {
  active: "Активна",
  inactive: "Неактивна",
};

const STATUS_TONE: Record<ParkingStatus, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  inactive: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
};

type StatusFilter = "all" | "active" | "inactive" | "archive";

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "Все",
  active: "Активные",
  inactive: "Неактивные",
  archive: "Архив",
};

type FormState = {
  id: string;
  name: string;
  city: string;
  capacity: string;
  occupied: string;
  status: ParkingStatus;
  notes: string;
  // Stored in abstract map space (x = lng field, y = lat field).
  x: number;
  y: number;
};

const emptyForm: FormState = {
  id: "", name: "", city: "", capacity: "10", occupied: "0", status: "active",
  notes: "", x: 500, y: 350,
};

export function ParkingsPage() {
  const toast = useToast();
  const parkingsQ = useQuery<Parking[]>({ queryKey: ADMIN_PARKINGS_KEY });
  useFleetStream(); // «Занято» зависит от велосипедов — обновляем ливе

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Parking | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const parkings = parkingsQ.data ?? [];

  const activeCount = parkings.filter((p) => !p.archivedAt && p.status === "active").length;
  const archivedCount = parkings.filter((p) => p.archivedAt).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return parkings
      // Archive view shows only soft-deleted points; every other view shows
      // only live (non-archived) points so archived never leak into them.
      .filter((p) => (statusFilter === "archive" ? !!p.archivedAt : !p.archivedAt))
      .filter((p) => statusFilter === "all" || statusFilter === "archive" || p.status === statusFilter)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) || (p.city ?? "").toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [parkings, search, statusFilter]);

  // Группировка по городам для таблицы: города из фикс-списка идут в его
  // порядке, прочие (демо/легаси) — по алфавиту после, «Без города» — в конце.
  const grouped = useMemo(() => {
    const byCity = new Map<string, Parking[]>();
    for (const p of filtered) {
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
  }, [filtered]);

  // The point currently being placed, shown live on the map as a parking marker.
  const draftParking: Parking = {
    id: editing?.id ?? "draft",
    name: form.name || "Новая парковка",
    city: form.city,
    lat: form.y, lng: form.x,
    capacity: Number(form.capacity) || 0,
    occupied: Number(form.occupied) || 0,
    status: form.status,
    notes: null, archivedAt: null, seed: false, createdAt: null, updatedAt: null,
  };

  // Markers shown on the editor map: the live draft plus every other live
  // parking (active visible, inactive muted) so the operator sees the draft in
  // context of the existing network. The point being edited is omitted from the
  // backdrop so its draft marker isn't drawn twice.
  const mapParkings: Parking[] = [
    draftParking,
    ...parkings.filter((p) => !p.archivedAt && p.id !== editing?.id),
  ];

  // ---------- Mutations ----------
  const saveMut = useMutation({
    mutationFn: async (payload: { editingId: string | null; body: any }) => {
      const { editingId, body } = payload;
      const res = editingId
        ? await apiRequest("PATCH", `/api/admin/parkings/${encodeURIComponent(editingId)}`, body)
        : await apiRequest("POST", "/api/admin/parkings", body);
      return res.json() as Promise<Parking>;
    },
    onSuccess: (p) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_PARKINGS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/parkings"] });
      setFormOpen(false);
      toast.toast({ title: editing ? "Парковка обновлена" : "Парковка добавлена", description: p.name });
    },
    onError: (err: any) => setFormError(err?.message?.replace(/^\d+:\s*/, "") ?? "Не удалось сохранить"),
  });

  const archiveMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/parkings/${encodeURIComponent(id)}/archive`);
      return res.json() as Promise<Parking>;
    },
    onSuccess: (p) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_PARKINGS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/parkings"] });
      toast.toast({ title: "Парковка в архиве", description: p.name });
    },
    onError: (err: any) => toast.toast({ title: "Не удалось", description: err?.message?.replace(/^\d+:\s*/, ""), variant: "destructive" }),
  });

  const restoreMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/parkings/${encodeURIComponent(id)}/restore`);
      return res.json() as Promise<Parking>;
    },
    onSuccess: (p) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_PARKINGS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/parkings"] });
      toast.toast({ title: "Парковка восстановлена", description: `${p.name} · неактивна` });
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
      queryClient.invalidateQueries({ queryKey: ADMIN_PARKINGS_KEY });
      toast.toast({
        title: "Переведена в архив",
        description: err?.message?.replace(/^\d+:\s*/, "") ?? "К парковке привязаны велосипеды",
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
  const openEdit = (p: Parking) => {
    setEditing(p);
    setForm({
      id: p.id,
      name: p.name,
      city: p.city ?? "",
      capacity: String(p.capacity),
      occupied: String(p.occupied),
      status: p.status as ParkingStatus,
      notes: p.notes ?? "",
      x: p.lng,
      y: p.lat,
    });
    setFormError(null);
    setFormOpen(true);
  };

  // Map click / center → abstract storage coords (inverse of the display map).
  const setCoordsFromReal = (coords: [number, number]) => {
    const { x, y } = realToMap(coords[0], coords[1]);
    setForm((f) => ({ ...f, x, y }));
  };
  // Real [lat, lng] for the manual fields, derived from the abstract coords so
  // operators see/edit human-readable values.
  const real = mapToReal(form.x, form.y);
  const setLat = (v: string) => {
    const lat = Number(v);
    if (!Number.isFinite(lat)) return;
    const { x, y } = realToMap(lat, real[1]);
    setForm((f) => ({ ...f, x, y }));
  };
  const setLng = (v: string) => {
    const lng = Number(v);
    if (!Number.isFinite(lng)) return;
    const { x, y } = realToMap(real[0], lng);
    setForm((f) => ({ ...f, x, y }));
  };

  const submitForm = () => {
    setFormError(null);
    const capacity = Number(form.capacity);
    if (!Number.isFinite(capacity) || capacity < 0) {
      setFormError("Вместимость должна быть числом ≥ 0");
      return;
    }
    if (form.name.trim().length < 2) {
      setFormError("Укажите название (минимум 2 символа)");
      return;
    }
    if (!form.city) {
      setFormError("Выберите город");
      return;
    }
    const common = {
      name: form.name,
      city: form.city,
      lat: form.y,
      lng: form.x,
      capacity,
      // occupied больше не вводится вручную — считается на сервере от велосипедов.
      status: form.status,
      notes: form.notes,
    };
    if (editing) {
      saveMut.mutate({ editingId: editing.id, body: common });
    } else {
      saveMut.mutate({ editingId: null, body: { ...(form.id.trim() ? { id: form.id.trim() } : {}), ...common } });
    }
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
      <header className="mb-6 flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Инфраструктура</div>
          <h1 className="font-display text-2xl lg:text-3xl font-light mt-1">
            Управление парковками
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {activeCount} активных
            {archivedCount > 0 ? ` · ${archivedCount} в архиве` : ""}. Точки парковки
            и стоянок для флота на побережье.
          </p>
        </div>
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
      </header>

      {activeCount === 0 && (
        <div
          className="mb-4 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300 px-4 py-3 text-sm"
          data-testid="parkings-no-active-warning"
        >
          Нет ни одной активной парковки. Клиенты не увидят точек на карте — добавьте или активируйте парковку.
        </div>
      )}

      <div className="flex items-center gap-2 mb-4" data-testid="parking-status-filter">
        {(["all", "active", "inactive", "archive"] as StatusFilter[]).map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(s)}
            data-testid={s === "archive" ? "filter-parkings-archive" : `filter-parking-${s}`}
          >
            {FILTER_LABEL[s]}
            {s === "archive" && archivedCount > 0 ? ` (${archivedCount})` : ""}
          </Button>
        ))}
      </div>

      <Card className="overflow-x-auto" data-testid="table-admin-parkings">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Код</TableHead>
              <TableHead>Название</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="text-right">Занято / Вмест.</TableHead>
              <TableHead>Координаты</TableHead>
              <TableHead className="text-right">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grouped.map(([city, rows]) => (
              <Fragment key={`grp-${city}`}>
                <TableRow className="bg-muted/50 hover:bg-muted/50" data-testid={`parking-city-group-${city}`}>
                  <TableCell colSpan={6} className="py-2">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <MapPin className="w-3.5 h-3.5" />{city}
                      <span className="font-normal normal-case tracking-normal">· {rows.length}</span>
                    </span>
                  </TableCell>
                </TableRow>
                {rows.map((p: Parking) => {
              const r = mapToReal(p.lng, p.lat);
              const isArchived = !!p.archivedAt;
              return (
                <TableRow
                  key={p.id}
                  data-testid={`row-admin-parking-${p.id}`}
                  className={`hover-elevate${isArchived ? " opacity-60" : ""}`}
                >
                  <TableCell className="font-mono text-sm">
                    <span className="inline-flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-muted-foreground" />{p.id}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    <div>{p.name}</div>
                    {p.notes && <div className="text-xs text-muted-foreground truncate max-w-xs">{p.notes}</div>}
                  </TableCell>
                  <TableCell>
                    {isArchived ? (
                      <Badge className="bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border-0">
                        Архив
                      </Badge>
                    ) : (
                      <Badge className={`${STATUS_TONE[p.status as ParkingStatus] ?? STATUS_TONE.inactive} border-0`}>
                        {STATUS_LABEL[p.status as ParkingStatus] ?? p.status}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-sm font-mono">{p.occupied} / {p.capacity}</TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">
                    {r[0].toFixed(4)}, {r[1].toFixed(4)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {isArchived ? (
                        <Button
                          variant="ghost" size="sm"
                          onClick={() => restoreMut.mutate(p.id)}
                          disabled={restoreMut.isPending}
                          title="Восстановить как неактивную"
                          data-testid="button-restore-parking"
                        >
                          <RotateCcw className="w-4 h-4 mr-1" /> Восстановить
                        </Button>
                      ) : (
                        <>
                          <Button variant="ghost" size="icon" onClick={() => openEdit(p)} title="Редактировать" data-testid={`button-edit-parking-${p.id}`}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost" size="icon"
                            onClick={() => archiveMut.mutate(p.id)}
                            disabled={archiveMut.isPending}
                            title="В архив"
                            data-testid={`button-archive-parking-${p.id}`}
                          >
                            <Archive className="w-4 h-4" />
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
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-12" data-testid="parkings-empty">
                  {search
                    ? "Ничего не найдено"
                    : statusFilter === "archive"
                      ? "В архиве пока нет парковок."
                      : "Парковок пока нет — добавьте первую."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* ---------- Add / edit dialog ---------- */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent data-testid="dialog-parking-form" className="max-h-[92vh] overflow-y-auto w-[95vw] sm:max-w-[95vw] lg:max-w-6xl">
          <DialogHeader>
            <DialogTitle className="font-display font-light">
              {editing ? `Редактирование ${editing.id}` : "Новая парковка"}
            </DialogTitle>
            <DialogDescription>
              Кликните по карте, чтобы выбрать точку, или укажите координаты вручную.
            </DialogDescription>
          </DialogHeader>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-2 md:col-span-2">
              <MapLibreMap
                parkings={mapParkings}
                height="70vh"
                className="relative w-full overflow-hidden rounded-xl border border-card-border bg-card"
                onMapClick={setCoordsFromReal}
              />
            </div>

            <div className="space-y-3">
              {!editing && (
                <Field label="Код / ID (необязательно)">
                  <Input
                    value={form.id}
                    onChange={(e) => setForm((f) => ({ ...f, id: e.target.value.toUpperCase() }))}
                    placeholder="Авто (P-16) или свой"
                    data-testid="input-parking-id"
                  />
                </Field>
              )}
              <Field label="Название">
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Напр. Зеленоградск · Маяк"
                  data-testid="input-parking-name"
                />
              </Field>
              <Field label="Город">
                <Select value={form.city} onValueChange={(v) => setForm((f) => ({ ...f, city: v }))}>
                  <SelectTrigger data-testid="select-parking-city">
                    <SelectValue placeholder="Выберите город" />
                  </SelectTrigger>
                  <SelectContent>
                    {PARKING_CITIES.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Статус">
                  <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as ParkingStatus }))}>
                    <SelectTrigger data-testid="select-parking-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Активна</SelectItem>
                      <SelectItem value="inactive">Неактивна</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Вместимость">
                  <Input
                    type="number" min={0}
                    value={form.capacity}
                    onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                    data-testid="input-parking-capacity"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Занято (авто)">
                  <Input
                    type="number"
                    value={editing ? String(editing.occupied) : "0"}
                    readOnly
                    disabled
                    data-testid="input-parking-occupied"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Считается автоматически по велосипедам на этой парковке.
                  </p>
                </Field>
                <div />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Широта (lat)">
                  <Input
                    value={real[0].toFixed(5)}
                    onChange={(e) => setLat(e.target.value)}
                    data-testid="input-parking-lat"
                  />
                </Field>
                <Field label="Долгота (lng)">
                  <Input
                    value={real[1].toFixed(5)}
                    onChange={(e) => setLng(e.target.value)}
                    data-testid="input-parking-lng"
                  />
                </Field>
              </div>
              <Field label="Инструкции / заметки (необязательно)">
                <Textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  data-testid="input-parking-notes"
                />
              </Field>

              {formError && (
                <div className="text-xs text-destructive" data-testid="parking-form-error">{formError}</div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} data-testid="button-parking-cancel">
              Отмена
            </Button>
            <Button onClick={submitForm} disabled={saveMut.isPending} data-testid="button-save-parking">
              {saveMut.isPending ? "Сохранение…" : "Сохранить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

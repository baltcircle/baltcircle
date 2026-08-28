import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Parking } from "@shared/schema";
import { PARKING_CITIES } from "@shared/schema";
import { realToMap } from "@shared/geo";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { MapLibreMap } from "@/components/MapLibreMap";
import { Field } from "@/components/FormField";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ADMIN_PARKINGS_KEY, emptyParkingForm, type ParkingFormState } from "./parking-utils";
// Статус больше не редактируется вручную — управляется только архивом/восстановлением.

export function ParkingFormDialog({
  open, onOpenChange, editing, parkings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Parking | null;
  /** Full live parking list, used as the map backdrop while placing a point. */
  parkings: Parking[];
}) {
  const toast = useToast();
  const [form, setForm] = useState<ParkingFormState>(emptyParkingForm);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setForm(editing ? {
      id: editing.id,
      name: editing.name,
      city: editing.city ?? "",
      capacity: String(editing.capacity),
      occupied: String(editing.occupied),
      radius: String(editing.radius),
      notes: editing.notes ?? "",
      x: editing.lng,
      y: editing.lat,
    } : emptyParkingForm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // The point currently being placed, shown live on the map as a parking marker.
  const draftParking: Parking = {
    id: editing?.id ?? "draft",
    name: form.name || "Новая парковка",
    city: form.city,
    lat: form.y, lng: form.x,
    capacity: Number(form.capacity) || 0,
    occupied: Number(form.occupied) || 0,
    radius: Number(form.radius) || 30,
    // Превью на карте всегда показывается как live-точка — статус теперь управляется только архивом.
    status: "active",
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
      onOpenChange(false);
      toast.toast({ title: editing ? "Парковка обновлена" : "Парковка добавлена", description: p.name });
    },
    onError: (err: any) => setFormError(err?.message?.replace(/^\d+:\s*/, "") ?? "Не удалось сохранить"),
  });

  // Map click / center → abstract storage coords (inverse of the display map).
  const setCoordsFromReal = (coords: [number, number]) => {
    const { x, y } = realToMap(coords[0], coords[1]);
    setForm((f) => ({ ...f, x, y }));
  };

  const submitForm = () => {
    setFormError(null);
    const capacity = Number(form.capacity);
    if (!Number.isFinite(capacity) || capacity < 0) {
      setFormError("Вместимость должна быть числом ≥ 0");
      return;
    }
    const radius = Number(form.radius);
    if (!Number.isInteger(radius) || radius < 1 || radius > 1000) {
      setFormError("Радиус должен быть целым числом от 1 до 1000 м");
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
      radius,
      // occupied больше не вводится вручную — считается на сервере от велосипедов.
      // status больше не отправляется вручную — сервер ставит "active" при создании
      // и управляет его дальше только через архив/восстановление.
      notes: form.notes,
    };
    if (editing) {
      saveMut.mutate({ editingId: editing.id, body: common });
    } else {
      saveMut.mutate({ editingId: null, body: { ...(form.id.trim() ? { id: form.id.trim() } : {}), ...common } });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-parking-form" className="max-h-[92vh] overflow-y-auto w-[95vw] sm:max-w-[95vw] lg:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="font-display font-light">
            {editing ? `Редактирование ${editing.id}` : "Новая парковка"}
          </DialogTitle>
          <DialogDescription>
            Кликните по карте, чтобы выбрать точку.
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
              <Field label="Вместимость">
                <Input
                  type="number" min={0}
                  value={form.capacity}
                  onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                  data-testid="input-parking-capacity"
                />
              </Field>
              <Field label="Радиус (м)">
                <Input
                  type="number" min={1} max={1000}
                  value={form.radius}
                  onChange={(e) => setForm((f) => ({ ...f, radius: e.target.value }))}
                  data-testid="input-parking-radius"
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
              </Field>
              <div />
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
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-parking-cancel">
            Отмена
          </Button>
          <Button onClick={submitForm} disabled={saveMut.isPending} data-testid="button-save-parking">
            {saveMut.isPending ? "Сохранение…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

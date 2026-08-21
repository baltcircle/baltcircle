import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Bike, BikeStatus, Parking } from "@shared/schema";
import { BIKE_STATUSES } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Field } from "@/components/FormField";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { LockPicker } from "./LockPicker";
import {
  ADMIN_BIKES_KEY, UNASSIGNED_LOCKS_KEY, STATUS_LABEL,
  emptyBikeForm, buildBikeSavePayload, liveLockBatteryDisplay,
  type BikeSaveForm, type UnassignedLock,
} from "./bike-utils";

export function BikeFormDialog({
  open, onOpenChange, editing, parkings, canWrite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Bike | null;
  parkings: Parking[];
  canWrite: boolean;
}) {
  const toast = useToast();
  const [form, setForm] = useState<BikeSaveForm>(emptyBikeForm);
  const [formError, setFormError] = useState<string | null>(null);

  // Re-seed the form whenever the dialog is (re)opened for a given target —
  // covers both "open the add form" and "open the edit form for bike X".
  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setForm(editing ? {
      id: editing.id,
      model: editing.model,
      status: editing.status as BikeStatus,
      serial: editing.serial ?? "",
      lockId: editing.lockId ?? "",
      lockImei: editing.lockImei ?? "",
      parkingId: editing.parkingId ?? "",
      notes: editing.notes ?? "",
      externalQrCode: editing.externalQrCode ?? "",
      isTestBike: editing.isTestBike ?? false,
    } : emptyBikeForm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // Locks are discovered asynchronously: the operator often opens this form
  // before the lock they just powered on has dialled in. Poll while the form is
  // open so the list fills in without the operator closing and reopening it.
  const locksQ = useQuery<UnassignedLock[]>({
    queryKey: UNASSIGNED_LOCKS_KEY,
    enabled: open && canWrite,
    refetchInterval: open ? 10_000 : false,
    staleTime: 0,
  });

  // A lock selected for a pending swap has not reported for this bike yet, so
  // never show the old lock's charge as though it were the selected lock's data.
  const displayedLock = editing?.lockImei === form.lockImei ? editing : null;
  const lockBattery = liveLockBatteryDisplay({
    battery: displayedLock?.battery ?? 0,
    lockImei: displayedLock?.lockImei ?? null,
    lockLastSeen: displayedLock?.lockLastSeen ?? null,
  });

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
      onOpenChange(false);
      toast.toast({ title: editing ? "Велосипед обновлён" : "Велосипед добавлен", description: bike.id });
    },
    // On success the claimed lock is no longer unassigned; on a lost race (409)
    // the picker must drop the lock the other operator took. Either way, refetch.
    onSettled: () => queryClient.invalidateQueries({ queryKey: UNASSIGNED_LOCKS_KEY }),
    onError: (err: any) => setFormError(err?.message?.replace(/^\d+:\s*/, "") ?? "Не удалось сохранить"),
  });

  const submitForm = () => {
    setFormError(null);
    if (editing) {
      saveMut.mutate({ editingId: editing.id, body: buildBikeSavePayload(form, editing) });
      return;
    }
    if (!form.lockImei) {
      setFormError("Выберите замок — без него велосипед нельзя отследить");
      return;
    }
    saveMut.mutate({ editingId: null, body: buildBikeSavePayload(form, null) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              <div
                className="rounded-md border border-input bg-muted/50 px-3 py-2 text-sm tabular-nums"
                data-testid="display-bike-battery"
                aria-label={`Заряд замка: ${lockBattery.value}`}
              >
                {lockBattery.value}
              </div>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="text-bike-battery-freshness">
                {lockBattery.freshness}
              </p>
            </Field>
          </div>
          <LockPicker
            value={form.lockImei}
            onChange={(imei) => setForm((f) => ({ ...f, lockImei: imei }))}
            locks={locksQ.data ?? []}
            loading={locksQ.isFetching}
            onRefresh={() => locksQ.refetch()}
            currentImei={editing?.lockImei ?? null}
            required={!editing}
          />
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
            {/* Legacy free-text label, kept for inventory notes. The IMEI
                above is what actually binds a lock to this bike. */}
            <Field label="Инв. номер замка (необязательно)">
              <Input
                value={form.lockId}
                onChange={(e) => setForm((f) => ({ ...f, lockId: e.target.value }))}
                placeholder="Своя маркировка"
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
          <Field label="QR замка производителя (необязательно)">
            <Input
              value={form.externalQrCode}
              onChange={(e) => setForm((f) => ({ ...f, externalQrCode: e.target.value.trim() }))}
              placeholder="Напр. 1738907596 — код с наклейки на замке"
              data-testid="input-bike-external-qr"
            />
          </Field>
          <div className="flex items-center justify-between rounded-md border border-input px-3 py-2">
            <div>
              <div className="text-sm font-medium">Тестовый велосипед</div>
              <p className="text-xs text-muted-foreground">
                Каждая поездка на нём помечается как тестовая (rides.isTest),
                при этом замок, геозона и трекинг работают как в реальной аренде.
              </p>
            </div>
            <Switch
              checked={form.isTestBike}
              onCheckedChange={(v) => setForm((f) => ({ ...f, isTestBike: v }))}
              data-testid="switch-bike-is-test"
            />
          </div>

          {formError && (
            <div className="text-xs text-destructive" data-testid="bike-form-error">{formError}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-bike-cancel">
            Отмена
          </Button>
          <Button
            onClick={submitForm}
            disabled={saveMut.isPending || (!editing && !form.lockImei)}
            data-testid="button-bike-save"
          >
            {saveMut.isPending ? "Сохранение…" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

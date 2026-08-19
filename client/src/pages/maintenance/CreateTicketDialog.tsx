import type { Bike } from "@shared/schema";
import { TICKET_KINDS, TICKET_PRIORITIES } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { KIND_LABEL, PRIORITY_LABEL, type CreateForm } from "./labels";

export function CreateTicketDialog({
  open, onOpenChange, form, setForm, bikes, assigneeOptions, onSubmit, submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: CreateForm;
  setForm: (updater: (s: CreateForm) => CreateForm) => void;
  bikes: Bike[];
  assigneeOptions: string[];
  onSubmit: () => void;
  submitting: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-create-ticket" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display font-light">Новая сервисная заявка</DialogTitle>
          <DialogDescription>Создайте заявку на обслуживание велосипеда.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Велосипед</div>
            <Input
              value={form.bikeId}
              onChange={(e) => setForm((s) => ({ ...s, bikeId: e.target.value.toUpperCase() }))}
              placeholder="BC-014"
              list="bike-ids"
              data-testid="input-ticket-bike"
            />
            <datalist id="bike-ids">
              {bikes.map((b) => <option key={b.id} value={b.id} />)}
            </datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Тип</div>
              <Select value={form.kind} onValueChange={(v) => setForm((s) => ({ ...s, kind: v }))}>
                <SelectTrigger data-testid="select-ticket-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TICKET_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Приоритет</div>
              <Select value={form.priority} onValueChange={(v) => setForm((s) => ({ ...s, priority: v }))}>
                <SelectTrigger data-testid="select-ticket-priority-new"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TICKET_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>{PRIORITY_LABEL[p]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Заголовок (необязательно)</div>
            <Input
              value={form.title}
              onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))}
              placeholder="Кратко"
              data-testid="input-ticket-title"
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Описание</div>
            <Textarea
              rows={3}
              value={form.message}
              onChange={(e) => setForm((s) => ({ ...s, message: e.target.value }))}
              placeholder="Что произошло?"
              data-testid="textarea-ticket-message"
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Исполнитель (необязательно)</div>
            <Input
              value={form.assignee}
              onChange={(e) => setForm((s) => ({ ...s, assignee: e.target.value }))}
              placeholder="Имя механика / бригады"
              list="ticket-assignees"
              data-testid="input-ticket-assignee"
            />
            <datalist id="ticket-assignees">
              {assigneeOptions.map((name) => <option key={name} value={name} />)}
            </datalist>
          </div>
          {(form.priority === "high" || form.priority === "critical") && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Велосипед будет переведён в обслуживание (если он доступен).
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-ticket-cancel">Отмена</Button>
          <Button
            onClick={onSubmit}
            disabled={!form.bikeId.trim() || form.message.trim().length < 2 || submitting}
            data-testid="button-submit-ticket"
          >
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { lockPickerOptions, type UnassignedLock } from "./bike-utils";

/**
 * Picks the physical lock a bike is fitted with.
 *
 * The options come from every non-decommissioned registry lock not bound to a
 * bike. A lock does not need to be online to be installed, so its last-seen
 * timestamp may be absent.
 */
export function LockPicker({
  value, onChange, locks, currentImei, required,
}: {
  value: string;
  onChange: (imei: string) => void;
  locks: UnassignedLock[];
  currentImei: string | null;
  required: boolean;
}) {
  // On edit the bike's own lock is (correctly) absent from the unassigned list,
  // but it must stay selectable or saving would look like removing the lock.
  const options = lockPickerOptions(locks, currentImei);

  return (
    <div className="block">
      <div className="text-xs font-medium text-muted-foreground mb-1">
        {required ? "Замок (обязательно)" : "Замок"}
      </div>
      {options.length === 0 ? (
        <div className="rounded-md border border-dashed p-3" data-testid="lock-picker-empty">
          <p className="text-xs text-muted-foreground">
            Свободных замков пока нет. Зарегистрируйте замок или проверьте, что
            он не назначен другому велосипеду.
          </p>
        </div>
      ) : (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger data-testid="select-bike-lock-imei">
            <SelectValue placeholder="Выберите замок" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} data-testid={`lock-option-${o.value}`}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

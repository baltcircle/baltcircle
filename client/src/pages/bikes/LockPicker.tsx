import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { fmtRelative } from "@/lib/format";
import { lockPickerOptions, type UnassignedLock, type DiscoveredLock } from "./bike-utils";

/**
 * Picks the physical lock a bike is fitted with.
 *
 * The options come from every non-decommissioned registry lock not bound to a
 * bike. A lock does not need to be online to be installed, so its last-seen
 * timestamp may be absent.
 *
 * `discovered` surfaces locks that have dialled into the OMNI gateway (e.g.
 * right after a SIM card was inserted) but have no registry row yet — they
 * are invisible to the Select above until registered. `onRegister` posts the
 * registration; the parent is responsible for invalidating/refetching both
 * queries once it settles.
 */
export function LockPicker({
  value, onChange, locks, discovered, registeringImei, onRegister, currentImei, required,
}: {
  value: string;
  onChange: (imei: string) => void;
  locks: UnassignedLock[];
  discovered: DiscoveredLock[];
  registeringImei: string | null;
  onRegister: (imei: string) => void;
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

      {discovered.length > 0 && (
        <div className="mt-2 rounded-md border border-dashed p-2 space-y-1.5" data-testid="discovered-locks-panel">
          <p className="text-[11px] text-muted-foreground">
            Обнаружены на сети, но ещё не зарегистрированы:
          </p>
          {discovered.map((d) => (
            <div key={d.imei} className="flex items-center justify-between gap-2 text-xs" data-testid={`discovered-lock-${d.imei}`}>
              <div>
                <span className="font-mono">{d.imei}</span>
                <span className="text-muted-foreground ml-2">{fmtRelative(d.lastSeen)}</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={registeringImei === d.imei}
                onClick={() => onRegister(d.imei)}
                data-testid={`button-register-lock-${d.imei}`}
              >
                {registeringImei === d.imei ? "Регистрация…" : "Зарегистрировать"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

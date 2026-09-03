import type { Bike, BikeStatus } from "@shared/schema";
import { fmtRelative } from "@/lib/format";

export const ADMIN_BIKES_KEY = ["/api/admin/bikes"] as const;
export const UNASSIGNED_LOCKS_KEY = ["/api/admin/locks/unassigned"] as const;
export const DISCOVERED_LOCKS_KEY = ["/api/admin/locks/discovered"] as const;

export const STATUS_LABEL: Record<BikeStatus, string> = {
  available: "Доступен",
  rented: "В аренде",
  reserved: "Бронь",
  maintenance: "Сервис",
  offline: "Оффлайн",
  storage: "На складе",
  lost: "Утерян",
  archived: "Архив",
};

export const STATUS_TONE: Record<BikeStatus, string> = {
  available: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  rented: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  reserved: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  maintenance: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  offline: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
  storage: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200",
  lost: "bg-rose-200 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  archived: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

export type BikeSaveForm = {
  id: string;
  status: BikeStatus;
  lockImei: string;
};

export const emptyBikeForm: BikeSaveForm = {
  id: "", status: "available", lockImei: "",
};

export type LockBatterySnapshot = {
  battery: number;
  lockImei: string | null;
  lockLastSeen: number | null;
};

/**
 * The bike snapshot is populated by lock telemetry. Do not surface the schema
 * default (100%) as a live reading until the bound lock has actually reported.
 */
export function liveLockBatteryDisplay(snapshot: LockBatterySnapshot): {
  value: string;
  freshness: string;
} {
  if (!snapshot.lockImei || !snapshot.lockLastSeen) {
    return { value: "—", freshness: "Нет данных" };
  }

  return {
    value: `${snapshot.battery}%`,
    freshness: `обновлено ${fmtRelative(snapshot.lockLastSeen)}`,
  };
}

/**
 * Battery is deliberately absent: it is a telemetry-owned bike snapshot, not
 * an operator-editable field. Creation uses the existing server schema default
 * of 100% until the newly bound lock reports its real charge.
 */
export function buildBikeSavePayload(
  form: BikeSaveForm,
  editing: Pick<Bike, "id" | "lockImei"> | null,
) {
  const common = {
    status: form.status,
  };

  if (editing) {
    // Only send the lock when it actually changed: an untouched edit must not
    // look like a lock swap (which resets the lock's live state server-side).
    const lockPatch = form.lockImei && form.lockImei !== editing.lockImei
      ? { lockImei: form.lockImei }
      : {};
    // Only send `id` when it actually changed: an untouched edit must not
    // trigger the rename transaction server-side.
    const idPatch = form.id && form.id !== editing.id ? { id: form.id } : {};
    return { ...common, ...lockPatch, ...idPatch };
  }

  return { id: form.id, lockImei: form.lockImei, ...common };
}

/** A non-decommissioned registry lock that is not fitted to a bike. */
export type UnassignedLock = { imei: string; lastSeen: number | null };

/** A lock seen dialling into the OMNI gateway but not yet registered at all. */
export type DiscoveredLock = { imei: string; firstSeen: number; lastSeen: number };

export type LockPickerOption = {
  /** The exact 15-digit IMEI submitted when an operator selects this option. */
  value: string;
  /** The operator-facing lock name. Keep this to the numeric IMEI only. */
  label: string;
};

export function lockPickerOptions(
  locks: UnassignedLock[],
  currentImei: string | null,
): LockPickerOption[] {
  return [
    ...(currentImei ? [{ value: currentImei, label: currentImei }] : []),
    ...locks
      .filter((lock) => lock.imei !== currentImei)
      .map((lock) => ({ value: lock.imei, label: lock.imei })),
  ];
}

// Escape HTML metacharacters before interpolating untrusted text into a raw
// document.write() string (the QR print window). Prevents stored XSS via
// operator-controlled bike id/model (audit M10).
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));
}

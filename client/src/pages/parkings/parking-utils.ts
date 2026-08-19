import type { ParkingStatus } from "@shared/schema";

export const ADMIN_PARKINGS_KEY = ["/api/admin/parkings"] as const;

export const STATUS_LABEL: Record<ParkingStatus, string> = {
  active: "Активна",
  inactive: "Неактивна",
};

export const STATUS_TONE: Record<ParkingStatus, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  inactive: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
};

export type StatusFilter = "all" | "active" | "inactive" | "archive";

export const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "Все",
  active: "Активные",
  inactive: "Неактивные",
  archive: "Архив",
};

export type ParkingFormState = {
  id: string;
  name: string;
  city: string;
  capacity: string;
  occupied: string;
  radius: string;
  status: ParkingStatus;
  notes: string;
  // Stored in abstract map space (x = lng field, y = lat field).
  x: number;
  y: number;
};

export const emptyParkingForm: ParkingFormState = {
  id: "", name: "", city: "", capacity: "10", occupied: "0", radius: "30", status: "active",
  notes: "", x: 500, y: 350,
};

import { TICKET_CLOSED_STATUSES } from "@shared/schema";

// Russian labels for the stored ids. Legacy auto-flag kinds are mapped too so
// older seeded/auto-generated tickets still render a friendly label.
export const KIND_LABEL: Record<string, string> = {
  wheel_puncture: "Колесо / прокол",
  brakes: "Тормоза",
  chain: "Цепь",
  handlebar_saddle: "Руль / седло",
  lock: "Замок",
  qr_sticker: "QR-наклейка",
  dirty: "Грязный велосипед",
  lost: "Потерян / не найден",
  other: "Другое",
  // legacy
  low_battery: "Низкий заряд замка",
  suspicious_idle: "Подозрительный простой",
  repair_request: "Заявка на ремонт",
  out_of_zone: "Вне зоны",
};

export const PRIORITY_LABEL: Record<string, string> = {
  low: "Низкий", medium: "Средний", high: "Высокий", critical: "Критический",
};
export const PRIORITY_TONE: Record<string, string> = {
  low: "text-muted-foreground border-border",
  medium: "text-sky-600 dark:text-sky-400 border-sky-500/40",
  high: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  critical: "text-destructive border-destructive/40",
};

export const STATUS_LABEL: Record<string, string> = {
  new: "Новая", open: "Новая", in_progress: "В работе",
  waiting_parts: "Ждёт запчасти", resolved: "Решена",
  closed: "Закрыта", cancelled: "Отменена",
};
export const STATUS_TONE: Record<string, string> = {
  new: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  open: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  in_progress: "text-sky-600 dark:text-sky-400 border-sky-500/40",
  waiting_parts: "text-violet-600 dark:text-violet-400 border-violet-500/40",
  resolved: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40",
  closed: "text-muted-foreground border-border",
  cancelled: "text-muted-foreground border-border",
};

export const normStatus = (s: string) => (s === "open" ? "new" : s);
export const isClosed = (s: string) => TICKET_CLOSED_STATUSES.includes(normStatus(s));

export type CreateForm = {
  bikeId: string; kind: string; priority: string; title: string; message: string; assignee: string;
};
export const emptyForm: CreateForm = {
  bikeId: "", kind: "wheel_puncture", priority: "medium", title: "", message: "", assignee: "",
};

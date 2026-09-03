import { TARIFFS, tariffLabelForHours, tariffLabelForRide } from "@shared/geo";
import type { UserRole } from "@shared/schema";

// Russian-facing role labels. "rider" is shown as «Клиент» in the UI even
// though the stored/internal role string stays "rider".
export const ROLE_LABEL: Record<UserRole, string> = {
  rider: "Клиент",
  mechanic: "Механик",
  operator: "Оператор",
  admin: "Администратор",
};

// Public base URL used to build scannable bike QR links. Configurable via
// VITE_PUBLIC_BASE_URL at build time; defaults to the production domain. The
// app uses clean path routing, so the deep link is "<base>/bike/<CODE>" — which
// the scan modal's extractBikeCode() parses (it also still accepts the legacy
// "<base>/#/bike/<CODE>" form printed on older labels).
const PUBLIC_BASE_URL = (
  (import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined) || "https://takeride.ru"
).replace(/\/+$/, "");

export function bikeQrLink(bikeId: string) {
  return `${PUBLIC_BASE_URL}/bike/${bikeId}`;
}

export function fmtRub(kopecks: number) {
  // Money is stored/transported in integer kopecks; divide for ruble display.
  const rub = Math.round(kopecks) / 100;
  const n = Number.isInteger(rub) ? rub : Math.round(rub);
  return n.toLocaleString("ru-RU") + " ₽";
}
export function fmtDistance(meters: number) {
  if (meters < 1000) return Math.round(meters) + " м";
  return (meters / 1000).toFixed(1) + " км";
}
export function fmtDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h} ч ${m % 60} мин`;
  // Меньше минуты — не пишем «0 мин», отрисовываем только секунды.
  if (m === 0) return `${s} с`;
  return `${m} мин ${String(s).padStart(2, "0")} с`;
}
export function fmtRelative(ts: number) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} д назад`;
}
export function fmtDate(ts: number) {
  return new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
// Date-only variant (no time) for contexts where the exact minute doesn't
// matter — e.g. a user's registration date in the admin table.
export function fmtDateOnly(ts: number) {
  return new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
}
// Average ride rating: one decimal place, "—" when the user has no feedback.
export function fmtRating(avg: number | null) {
  return avg === null ? "—" : avg.toFixed(1);
}

// A single ride's 1..5 rider rating (rides_feedback.rating), as opposed to
// fmtRating's decimal AVERAGE across many rides. `null` covers both an
// active ride (feedback can't exist yet) and a completed one the rider
// skipped feedback for — both render the same "no rating" dash. Shown as a
// bare digit (no "/5" suffix) per the ratings-column convention.
export function fmtRideRating(rating: number | null): string {
  return rating === null ? "—" : `${rating}`;
}

// Legacy tariff ids may still appear on older rides; keep readable fallbacks.
const LEGACY_TARIFF_LABELS: Record<string, string> = {
  payg: "По минутам",
  day: "Дневной",
  month: "Месячный",
};
export function fmtTariff(id: string) {
  const t = TARIFFS.find((x) => x.id === id);
  if (t) return t.name;
  return LEGACY_TARIFF_LABELS[id] ?? id;
}

// Display label for the CUMULATIVE paid duration of a ride (rides.totalTariffHours
// — initial tariff + every extension), e.g. "2 часа" for an h1 ride extended once
// by another h1. Use this instead of fmtTariff(ride.tariff) anywhere a ride's
// TOTAL paid duration is shown — fmtTariff only ever reflects the ORIGINAL
// tariff picked at start and silently ignores extensions.
export function fmtTariffHours(hours: number): string {
  return tariffLabelForHours(hours);
}

// Like fmtTariffHours, but resolves sub-hour tariffs and extensions of them
// (currently only the "m1" test tariff) correctly instead of showing the
// generic zero-hour fallback — see tariffLabelForRide's comment in
// shared/geo.ts. Prefer this over fmtTariffHours wherever the ride object
// is available.
export function fmtRideTariff(ride: { tariff: string; totalTariffMs: number }): string {
  return tariffLabelForRide(ride);
}

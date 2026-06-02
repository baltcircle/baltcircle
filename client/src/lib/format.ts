export function fmtRub(value: number) {
  const n = Math.round(value);
  return n.toLocaleString("ru-RU") + " ₽";
}
export function fmtDistance(meters: number) {
  if (meters < 1000) return Math.round(meters) + " м";
  return (meters / 1000).toFixed(meters < 10000 ? 2 : 1) + " км";
}
export function fmtDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h} ч ${m % 60} мин`;
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

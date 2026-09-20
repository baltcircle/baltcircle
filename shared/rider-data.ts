import type { RideWithFeedback, SupportConversation, SupportMessage } from "./schema";

export type RiderHistoryPage = { items: RideWithFeedback[]; nextBefore: string | null };
export type RiderStats = { rides: number; distanceM: number };
export type SupportPage = {
  conversation: SupportConversation;
  messages: SupportMessage[];
  nextBefore: number | null;
};
export function historyCursor(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
export function rideHistoryCursor(value: unknown): { startedAt: number; id: number } | undefined {
  if (typeof value !== "string" || !/^\d+:\d+$/.test(value)) return undefined;
  const [startedAt, id] = value.split(":").map(Number);
  return Number.isSafeInteger(startedAt) && startedAt >= 0 && historyCursor(id) ? { startedAt, id } : undefined;
}
// Input is newest first, fetched with limit + 1. The wire format is chronological.
export function supportPage<T extends { id: number }>(rows: T[], limit: number) {
  const messages = rows.slice(0, limit).reverse();
  return { messages, nextBefore: rows.length > limit ? messages[0].id : null };
}

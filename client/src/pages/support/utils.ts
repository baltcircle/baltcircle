import type { SupportConversation, SupportMessage } from "@shared/schema";

export const CHAT_KEY = ["/api/support/chat"];
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export type ChatState = { conversation: SupportConversation; messages: SupportMessage[] };

// Вопросы совпадают с ключевыми словами бота (shared/support-faq.ts) —
// тап отправляет вопрос, бот отвечает скриптом.
export const FAQ_HINT = [
  { q: "Как начать аренду велосипеда?" },
  { q: "Как завершить поездку?" },
  { q: "Как привязать карту и сколько стоит?" },
  { q: "Что означают зоны на карте?" },
];

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
export function fmtDay(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86400000);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday) return "Сегодня";
  if (isYesterday) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "long" });
}

export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("Не удалось прочитать файл"));
    r.readAsDataURL(file);
  });
}

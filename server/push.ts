// Web Push (VAPID) sender.
//
// Клиент подписывается через Push API браузера, отдаёт нам endpoint + p256dh + auth.
// Мы храним подписки в push_subscriptions и рассылаем через web-push с VAPID-ключами.
//
// Автоматически удаляем "мёртвые" подписки при HTTP 404/410 от push-сервиса.

import webpush from "web-push";
import { db } from "./db/bootstrap";
import { pushSubscriptions, type PushSubscription } from "@shared/schema";
import { and, eq } from "drizzle-orm";

function log(message: string, source = "push"): void {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${time} [${source}] ${message}`);
}

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const CONTACT = process.env.VAPID_CONTACT ?? "mailto:no-reply@takeride.ru";

let configured = false;
export function isPushConfigured(): boolean {
  if (configured) return true;
  if (!PUBLIC_KEY || !PRIVATE_KEY) return false;
  try {
    webpush.setVapidDetails(CONTACT, PUBLIC_KEY, PRIVATE_KEY);
    configured = true;
    return true;
  } catch (err) {
    log(`VAPID init failed: ${(err as Error).message}`);
    return false;
  }
}

export function getVapidPublicKey(): string {
  return PUBLIC_KEY;
}

export interface PushPayload {
  title: string;
  body: string;
  // Абсолютный или относительный путь для клика по уведомлению.
  url?: string;
  // Кастомный tag для группировки/замены (например "support" — новое сообщение
  // затирает предыдущее непрочитанное).
  tag?: string;
  // Иконка (по умолчанию берётся из SW).
  icon?: string;
  // Произвольные данные, попадают в event.notification.data на клиенте.
  data?: Record<string, unknown>;
}

interface SendResult {
  sent: number;
  removed: number;
  failed: number;
}

/**
 * Разослать push всем подпискам пользователя. Возвращает статистику.
 * Мёртвые endpoint'ы (404/410) удаляются из БД.
 */
export async function sendToUser(userId: string, payload: PushPayload): Promise<SendResult> {
  if (!isPushConfigured()) {
    log(`skip send to ${userId}: VAPID not configured`);
    return { sent: 0, removed: 0, failed: 0 };
  }

  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));

  if (subs.length === 0) return { sent: 0, removed: 0, failed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let removed = 0;
  let failed = 0;

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.authKey },
        },
        body,
        { TTL: 60 * 60 * 24 }, // 24h
      );
      sent += 1;
      // Обновляем last_success_at, но не блокируем на ошибке апдейта.
      db.update(pushSubscriptions)
        .set({ lastSuccessAt: Date.now() })
        .where(eq(pushSubscriptions.id, sub.id))
        .catch(() => {});
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Подписка мертва — удаляем.
        try {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
          removed += 1;
        } catch { /* noop */ }
      } else {
        failed += 1;
        log(`send failed (user=${userId}, status=${status}): ${(err as Error).message}`);
      }
    }
  }));

  log(`sent to ${userId}: sent=${sent} removed=${removed} failed=${failed} of ${subs.length}`);
  return { sent, removed, failed };
}

/** Fire-and-forget: не блокируем HTTP-хендлер на push-рассылке. */
export function sendToUserAsync(userId: string, payload: PushPayload): void {
  sendToUser(userId, payload).catch((err) => {
    log(`sendToUserAsync error (user=${userId}): ${(err as Error).message}`);
  });
}

export async function upsertSubscription(input: {
  userId: string;
  endpoint: string;
  p256dh: string;
  authKey: string;
  userAgent?: string;
}): Promise<PushSubscription> {
  const now = Date.now();
  // UPSERT по endpoint: если та же подписка привязана к другому userId — перепривязываем.
  const [row] = await db
    .insert(pushSubscriptions)
    .values({
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      authKey: input.authKey,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastSuccessAt: null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: input.userId,
        p256dh: input.p256dh,
        authKey: input.authKey,
        userAgent: input.userAgent ?? null,
      },
    })
    .returning();
  return row;
}

export async function removeSubscription(userId: string, endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

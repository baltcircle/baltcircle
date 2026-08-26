import type { Express, Request, Response } from "express";
import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { storage } from "../storage";
import type { SupportMessage } from "@shared/schema";
import { sendSupportMessageSchema } from "@shared/schema";
import { matchFaq, wantsOperator, BOT_FALLBACK, BOT_HANDOFF } from "@shared/support-faq";
import { riderId, requireAuth, requireRole, actorName } from "./context";
import { sendToUserAsync } from "../push";
import {
  isObjectStorageConfigured, putSupportAttachment, presignSupportAttachment,
  PREVIEW_URL_TTL_SECONDS, MESSAGE_URL_TTL_SECONDS,
} from "../storage/object-storage";
import { logger } from "../logger";

// -------- SSE fan-out для поддержки --------
// Event name = conversation_id (число как строка) → пуш идёт только владельцу
// разговора и активному оператору, слушающему этот же id.
const supportEvents = new EventEmitter();
supportEvents.setMaxListeners(0);

// -------- Загрузка файлов --------
// Прод: Yandex Object Storage (приватный бакет, presigned URL, см.
// ../storage/object-storage.ts). Без секретов YANDEX_OS_* (dev/CI/тесты) —
// откат на локальный диск, как в исходном MVP.
//
// Хранимое в БД значение attachmentUrl двух видов, различимых по префиксу:
//   - начинается с "/"           → legacy: абсолютный путь на локальном диске,
//                                    отдаётся статикой /uploads как раньше.
//   - не начинается с "/"        → ключ объекта в Object Storage
//                                    ("support/<uuid>.<ext>"); реальный URL
//                                    получается через resolveAttachmentUrl()
//                                    прямо перед отправкой клиенту — никогда
//                                    не кладём presigned-ссылку в БД, она бы
//                                    протухла.
const UPLOADS_ROOT = process.env.UPLOADS_DIR ?? path.resolve(process.cwd(), "uploads");
const UPLOADS_DIR = path.join(UPLOADS_ROOT, "support");
const UPLOAD_PUBLIC_PREFIX = "/uploads/support";
const OS_KEY_PREFIX = "support/";

// Разрешённые MIME: только изображения. Ограничение — 8 МБ (после base64 ~10.6 МБ).
const ALLOWED_MIMES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif",
]);
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  mime: z.string().trim().min(3).max(120),
  dataBase64: z.string().min(10).max(20 * 1024 * 1024), // sanity cap ~14MB base64
});

async function ensureUploadDir(): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  if (m === "image/heic") return "heic";
  if (m === "image/heif") return "heif";
  return "bin";
}

/** Записывает вложение и возвращает { url, previewUrl, mime }:
 *  - `url`      — долгоживущее значение для хранения в БД (attachmentUrl в
 *              POST /api/support/chat) — ключ Object Storage или локальный путь.
 *  - `previewUrl` — сразу работающая ссылка для превью в композере до
 *              отправки сообщения (для локального диска совпадает с `url`).
 */
export async function saveAttachment(buf: Buffer, mime: string): Promise<{ url: string; previewUrl: string; mime: string }> {
  const id = randomUUID();
  const ext = extForMime(mime);
  if (isObjectStorageConfigured()) {
    const key = `${OS_KEY_PREFIX}${id}.${ext}`;
    await putSupportAttachment(key, buf, mime);
    const previewUrl = await presignSupportAttachment(key, PREVIEW_URL_TTL_SECONDS);
    return { url: key, previewUrl, mime };
  }
  // Локальный диск (dev/CI или прод до настройки бакета).
  await ensureUploadDir();
  const filename = `${id}.${ext}`;
  await fs.writeFile(path.join(UPLOADS_DIR, filename), buf);
  const url = `${UPLOAD_PUBLIC_PREFIX}/${filename}`;
  return { url, previewUrl: url, mime };
}

/** Превращает собщения в отдаваемый клиенту вид: attachmentUrl содержит
 * рабочую ссылку, а не внутренний ключ хранения. Присваивание — чисто
 * локальное вычисление (без сетевого вызова), безопасно делать на каждое
 * сообщение при каждой выдаче истории. Ошибка presign не должна ронять выдачу
 * сообщений — логируется, вложение пришлёт как null.
 */
export async function resolveOutgoingMessage(msg: SupportMessage): Promise<SupportMessage> {
  if (!msg.attachmentUrl || msg.attachmentUrl.startsWith("/")) return msg;
  try {
    const url = await presignSupportAttachment(msg.attachmentUrl, MESSAGE_URL_TTL_SECONDS);
    return { ...msg, attachmentUrl: url };
  } catch (err) {
    logger.error({ err, messageId: msg.id }, "support: не удалось подписать URL вложения");
    return { ...msg, attachmentUrl: null };
  }
}

export async function resolveOutgoingMessages(msgs: SupportMessage[]): Promise<SupportMessage[]> {
  return Promise.all(msgs.map(resolveOutgoingMessage));
}

// ------------------------------------------------------------------------------------
export function registerSupportChatRoutes(app: Express): void {
  // -------------------- RIDER SIDE --------------------

  // История сообщений своего разговора + метаданные (unread).
  app.get("/api/support/chat", requireAuth, async (req, res) => {
    const uid = riderId(req);
    const conv = await storage.ensureSupportConversation(uid);
    const after = Number.parseInt(String(req.query.after ?? ""), 10);
    const rawMessages = await storage.listSupportMessages(conv.id, {
      afterId: Number.isFinite(after) && after > 0 ? after : undefined,
    });
    const messages = await resolveOutgoingMessages(rawMessages);
    res.json({ conversation: conv, messages });
  });

  // Отправка текстового сообщения / вложения.
  app.post("/api/support/chat", requireAuth, async (req, res) => {
    const parsed = sendSupportMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте сообщение";
      return res.status(400).json({ error: msg });
    }
    const uid = riderId(req);
    const conv = await storage.ensureSupportConversation(uid);
    const body = (parsed.data.body ?? "").trim();

    // 1. Сохраняем сообщение пользователя.
    const msg = await storage.appendSupportMessage({
      conversationId: conv.id,
      senderRole: "user",
      senderId: uid,
      body,
      attachmentUrl: parsed.data.attachmentUrl ?? null,
      attachmentMime: parsed.data.attachmentMime ?? null,
    });
    const resolvedMsg = await resolveOutgoingMessage(msg);
    supportEvents.emit(String(conv.id), resolvedMsg);
    supportEvents.emit("inbox", { conversationId: conv.id }); // будит SSE админа
    res.status(201).json(resolvedMsg);

    // 2. Бот-логика — только если разговор ещё в режиме 'bot'. В human-режиме
    //    (оператор уже подключён) бот молчит. Отвечаем асинхронно после ответа
    //    клиенту, чтобы не задерживать отправку сообщения.
    if (conv.mode === "human") return;

    // Запрос живого оператора → переключаем на human, шлём handoff, будим инбокс.
    if (body && wantsOperator(body)) {
      await storage.setSupportMode(conv.id, "human");
      const handoff = await storage.appendSupportMessage({
        conversationId: conv.id,
        senderRole: "system",
        senderId: null,
        body: BOT_HANDOFF,
      });
      supportEvents.emit(String(conv.id), handoff);
      supportEvents.emit("inbox", { conversationId: conv.id, escalated: true });
      return;
    }

    // Вложение без текста — бот не угадывает, тихо ждёт (сообщение уже у оператора
    // в инбоксе). Отвечаем скриптом только на текстовые вопросы.
    if (!body) return;

    const faq = matchFaq(body);
    const answer = faq ? faq.answer : BOT_FALLBACK;
    const botMsg = await storage.appendSupportMessage({
      conversationId: conv.id,
      senderRole: "bot",
      senderId: null,
      body: answer,
    });
    supportEvents.emit(String(conv.id), botMsg);
  });

  // Пометить как прочитанное со стороны пользователя.
  app.post("/api/support/chat/read", requireAuth, async (req, res) => {
    const uid = riderId(req);
    const conv = await storage.ensureSupportConversation(uid);
    await storage.markSupportRead(conv.id, "user");
    res.json({ ok: true });
  });

  // SSE-стрим новых сообщений для этого пользователя.
  app.get("/api/support/chat/stream", requireAuth, async (req, res) => {
    const uid = riderId(req);
    const conv = await storage.ensureSupportConversation(uid);
    setupSse(res, req, String(conv.id));
  });

  // Загрузка вложения. Возвращает { url, mime } — клиент шлёт их в POST /chat.
  app.post("/api/support/chat/upload", requireAuth, async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Неверный формат вложения" });
    }
    const mime = parsed.data.mime.toLowerCase();
    if (!ALLOWED_MIMES.has(mime)) {
      return res.status(400).json({ error: "Разрешены только изображения" });
    }
    // Убираем возможный "data:image/...;base64," префикс.
    const payload = parsed.data.dataBase64.replace(/^data:[^;]+;base64,/, "");
    let buf: Buffer;
    try {
      buf = Buffer.from(payload, "base64");
    } catch {
      return res.status(400).json({ error: "Не удалось декодировать файл" });
    }
    if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) {
      return res.status(400).json({ error: "Файл слишком большой (макс. 8 МБ)" });
    }
    const saved = await saveAttachment(buf, mime);
    res.status(201).json({ url: saved.url, previewUrl: saved.previewUrl, mime: saved.mime });
  });

  // -------------------- OPERATOR SIDE --------------------

  // Список всех разговоров (inbox).
  app.get("/api/admin/support/chats", requireRole("operator", "admin"), async (_req, res) => {
    res.json(await storage.listAllSupportConversations());
  });

  // История конкретного разговора.
  app.get("/api/admin/support/chats/:id", requireRole("operator", "admin"), async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Неверный id" });
    const conv = await storage.getSupportConversation(id);
    if (!conv) return res.status(404).json({ error: "Разговор не найден" });
    const after = Number.parseInt(String(req.query.after ?? ""), 10);
    const rawMessages = await storage.listSupportMessages(id, {
      afterId: Number.isFinite(after) && after > 0 ? after : undefined,
    });
    const messages = await resolveOutgoingMessages(rawMessages);
    res.json({ conversation: conv, messages });
  });

  // Ответ оператора.
  app.post("/api/admin/support/chats/:id", requireRole("operator", "admin"), async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Неверный id" });
    const conv = await storage.getSupportConversation(id);
    if (!conv) return res.status(404).json({ error: "Разговор не найден" });
    const parsed = sendSupportMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте сообщение";
      return res.status(400).json({ error: msg });
    }
    const opName = await actorName(req);
    // Оператор ответил вручную → выключаем бота для этого разговора.
    if (conv.mode !== "human") {
      await storage.setSupportMode(id, "human");
    }
    const msg = await storage.appendSupportMessage({
      conversationId: id,
      senderRole: "operator",
      senderId: req.session?.userId ?? null,
      body: parsed.data.body ?? "",
      attachmentUrl: parsed.data.attachmentUrl ?? null,
      attachmentMime: parsed.data.attachmentMime ?? null,
    });
    // Сохраним имя оператора в системном поле? Не нужно — фронт может показать "Оператор" при senderRole=operator.
    void opName;
    const resolvedMsg = await resolveOutgoingMessage(msg);
    supportEvents.emit(String(id), resolvedMsg);
    supportEvents.emit("inbox", { conversationId: id });
    // Web Push клиенту-владельцу разговора. Fire-and-forget.
    const preview = (parsed.data.body ?? "").trim();
    const previewShort = preview.length > 140 ? preview.slice(0, 137) + "…" : preview;
    sendToUserAsync(conv.userId, {
      title: "Поддержка",
      body: previewShort || (parsed.data.attachmentUrl ? "📎 Вложение" : "Новое сообщение"),
      url: "/support",
      tag: `support:${id}`,
      data: { kind: "support", conversationId: id },
    });
    res.status(201).json(resolvedMsg);
  });

  // Пометить прочитанным со стороны оператора.
  app.post("/api/admin/support/chats/:id/read", requireRole("operator", "admin"), async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: "Неверный id" });
    await storage.markSupportRead(id, "operator");
    res.json({ ok: true });
  });

  // SSE для оператора: разговор.
  app.get("/api/admin/support/chats/:id/stream", requireRole("operator", "admin"), async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).end();
    setupSse(res, req, String(id));
  });

  // SSE-инбокс для оператора: пуш при новом сообщении в любом разговоре.
  app.get("/api/admin/support/inbox/stream", requireRole("operator", "admin"), async (req, res) => {
    setupSse(res, req, "inbox");
  });

  // Загрузка вложения оператором.
  app.post("/api/admin/support/upload", requireRole("operator", "admin"), async (req, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Неверный формат вложения" });
    const mime = parsed.data.mime.toLowerCase();
    if (!ALLOWED_MIMES.has(mime)) return res.status(400).json({ error: "Разрешены только изображения" });
    const payload = parsed.data.dataBase64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(payload, "base64");
    if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) {
      return res.status(400).json({ error: "Файл слишком большой (макс. 8 МБ)" });
    }
    const saved = await saveAttachment(buf, mime);
    res.status(201).json({ url: saved.url, previewUrl: saved.previewUrl, mime: saved.mime });
  });
}

// SSE helper. Подписывается на shared EventEmitter по каналу channelKey.
function setupSse(res: Response, req: Request, channelKey: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  const onEvent = (payload: unknown) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch { /* сокет уже закрыт — почистит cleanup */ }
  };
  supportEvents.on(channelKey, onEvent);

  // Стартовый ping чтобы клиент понял что соединение живо.
  res.write(": ok\n\n");

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": ping\n\n");
  }, 25000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    supportEvents.off(channelKey, onEvent);
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}

// Экспортируем директорию для использования в static-сервере.
export { UPLOADS_DIR, UPLOAD_PUBLIC_PREFIX };

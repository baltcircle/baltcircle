// Yandex Object Storage (S3-совместимый API) для вложений support-чата.
//
// Приватный бакет: файлы никогда не публично читаемы. Клиент получает
// presigned GET URL, генерируемый заново при каждой выдаче сообщений — это
// чистое локальное вычисление подписи (SigV4), без сетевого похода к S3, так
// что вызывать его на каждое сообщение при каждом чтении списка безопасно по
// латентности.
//
// Конфигурация не задана (нет YANDEX_OS_BUCKET) → isObjectStorageConfigured()
// возвращает false, и вызывающий код (server/http/support.ts) откатывается на
// локальный диск — это держит dev/CI/тесты рабочими без реальных облачных
// ключей, а прод активируется просто добавлением секретов в GitHub Actions
// без изменений кода.
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const BUCKET = process.env.YANDEX_OS_BUCKET ?? "";
const ENDPOINT = process.env.YANDEX_OS_ENDPOINT ?? "https://storage.yandexcloud.net";
const REGION = process.env.YANDEX_OS_REGION ?? "ru-central1";
const ACCESS_KEY_ID = process.env.YANDEX_OS_ACCESS_KEY_ID ?? "";
const SECRET_ACCESS_KEY = process.env.YANDEX_OS_SECRET_ACCESS_KEY ?? "";

// TTL превью сразу после аплоада (композер чата) — короткий, файл почти
// сразу же либо отправляется (после чего URL всё равно перевыпускается при
// каждом показе истории), либо отбрасывается пользователем.
export const PREVIEW_URL_TTL_SECONDS = 15 * 60;
// TTL при показе уже отправленного сообщения — сессия просмотра истории чата
// (открыл вкладку, читает) не должна упереться в истечение подписи.
export const MESSAGE_URL_TTL_SECONDS = 24 * 60 * 60;

let client: S3Client | null = null;

export function isObjectStorageConfigured(): boolean {
  return Boolean(BUCKET && ACCESS_KEY_ID && SECRET_ACCESS_KEY);
}

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint: ENDPOINT,
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
      // Yandex Object Storage требует path-style адресацию бакетов.
      forcePathStyle: true,
    });
  }
  return client;
}

/** Кладёт файл в бакет под ключом `support/<id>.<ext>`. Бросает при сетевой
 * ошибке/недоступности бакета — вызывающий код должен вернуть 502/500. */
export async function putSupportAttachment(key: string, buf: Buffer, mime: string): Promise<void> {
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buf,
    ContentType: mime,
    // Явно НЕ публичный: бакет и объекты приватные, доступ только по
    // presigned URL с ограниченным сроком действия.
  }));
}

/** Presigned GET URL для приватного объекта. Чистое локальное вычисление
 * подписи — не делает сетевой запрос, безопасно вызывать массово. */
export async function presignSupportAttachment(key: string, ttlSeconds: number): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(getClient(), cmd, { expiresIn: ttlSeconds });
}

/** Читает объект из бакета целиком в память — используется только миграционным
 * скриптом (см. scripts/migrate-support-attachments.ts), не в горячем пути. */
export { GetObjectCommand };
export function getClientForMigration(): S3Client {
  return getClient();
}
export const SUPPORT_BUCKET = BUCKET;

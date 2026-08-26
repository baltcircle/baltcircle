// One-shot data migration: support-chat attachments on local disk
// (UPLOADS_DIR/support/*) -> Yandex Object Storage (private bucket).
//
// For every file found locally:
//   1. Uploads it to the bucket under key "support/<filename>".
//   2. Updates every support_messages row whose attachment_url equals the
//      legacy "/uploads/support/<filename>" path to the new bare key
//      "support/<filename>" (no leading slash — see server/http/support.ts
//      for the convention distinguishing legacy paths from OS keys).
//   3. Leaves the local file in place — deletion is a manual follow-up once
//      the migration is verified in production (kept reversible).
//
// Idempotent: rows already migrated (attachment_url without a leading "/")
// are left untouched, and re-uploading the same key to the bucket is a safe
// overwrite. Safe to re-run after a partial failure.
//
// Requires YANDEX_OS_BUCKET + credentials to be set — refuses to run
// against local-disk-only config since there would be nothing to migrate to.
//
// Usage:
//   DATABASE_URL=postgres://... \
//   YANDEX_OS_BUCKET=... YANDEX_OS_ACCESS_KEY_ID=... YANDEX_OS_SECRET_ACCESS_KEY=... \
//   LOCAL_UPLOADS_DIR=/app/uploads \
//   npx tsx script/migrate-support-attachments.ts [--dry-run]
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { isObjectStorageConfigured, putSupportAttachment } from "../server/storage/object-storage";

const DATABASE_URL = process.env.DATABASE_URL;
const LOCAL_UPLOADS_ROOT = process.env.LOCAL_UPLOADS_DIR ?? process.env.UPLOADS_DIR ?? path.resolve(process.cwd(), "uploads");
const SUPPORT_DIR = path.join(LOCAL_UPLOADS_ROOT, "support");
const DRY_RUN = process.argv.includes("--dry-run");

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", gif: "image/gif",
};

async function main() {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  if (!isObjectStorageConfigured()) {
    console.error("YANDEX_OS_BUCKET/YANDEX_OS_ACCESS_KEY_ID/YANDEX_OS_SECRET_ACCESS_KEY must be set — nothing to migrate to.");
    process.exit(1);
  }

  let files: string[];
  try {
    files = await fs.readdir(SUPPORT_DIR);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      console.log(`ℹ️ ${SUPPORT_DIR} does not exist — nothing to migrate.`);
      return;
    }
    throw err;
  }

  if (files.length === 0) {
    console.log("ℹ️ No local attachment files found — nothing to migrate.");
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  let uploaded = 0;
  let dbUpdated = 0;
  let failed = 0;

  try {
    for (const filename of files) {
      const legacyUrl = `/uploads/support/${filename}`;
      const newKey = `support/${filename}`;
      const ext = filename.split(".").pop()?.toLowerCase() ?? "";
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";

      try {
        const filePath = path.join(SUPPORT_DIR, filename);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;

        if (DRY_RUN) {
          console.log(`[dry-run] would upload ${filename} (${stat.size} bytes, ${mime}) -> ${newKey}`);
          continue;
        }

        const buf = await fs.readFile(filePath);
        await putSupportAttachment(newKey, buf, mime);
        uploaded++;

        const result = await pool.query(
          `UPDATE support_messages SET attachment_url = $1 WHERE attachment_url = $2`,
          [newKey, legacyUrl],
        );
        dbUpdated += result.rowCount ?? 0;
        console.log(`✅ ${filename} -> ${newKey} (${result.rowCount ?? 0} row(s) updated)`);
      } catch (err) {
        failed++;
        console.error(`❌ Failed to migrate ${filename}:`, err);
      }
    }
  } finally {
    await pool.end();
  }

  console.log(`\nDone. Uploaded: ${uploaded}, DB rows updated: ${dbUpdated}, failed: ${failed}, total files: ${files.length}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

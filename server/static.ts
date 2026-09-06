import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";

// Файлы, которые НИКОГДА нельзя кэшировать: их имена не хэшируются, и именно
// они решают, какую версию приложения получит пользователь.
// - index.html ссылается на текущие /assets/*-<hash>.js
// - version.json читает клиентская проверка обновлений
// - sw.js и manifest.webmanifest определяют поведение установленной PWA
const NO_CACHE = new Set(["/index.html", "/version.json", "/sw.js", "/manifest.webmanifest"]);

function applyCacheHeaders(res: express.Response, filePath: string): void {
  const rel = "/" + path.basename(filePath);
  if (NO_CACHE.has(rel)) {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    return;
  }
  // Всё в /assets собрано Vite с хэшем в имени — содержимое по такому URL
  // неизменно, поэтому кэшируем навсегда. Именно это делает перезагрузку
  // после выкатки дешёвой: тянется только новый бандл.
  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }
  // Иконки и прочая статика без хэша — короткий кэш с ревалидацией.
  res.setHeader("Cache-Control", "public, max-age=3600");
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath, { setHeaders: applyCacheHeaders }));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

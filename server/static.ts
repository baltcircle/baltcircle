import express from 'express';
import type { Express } from 'express';
import fs from "node:fs";
import path from "node:path";
import { staticAssetLimiter, pageLimiter } from "./asset-security";

// Unhashed PWA entrypoints must always revalidate.
const NO_CACHE = new Set(["/index.html", "/version.json", "/sw.js", "/manifest.webmanifest"]);

function applyCacheHeaders(res: express.Response, filePath: string): void {
  const rel = "/" + path.basename(filePath);
  if (NO_CACHE.has(rel)) {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    return;
  }
  if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }
  app.use(staticAssetLimiter, express.static(distPath, { setHeaders: applyCacheHeaders }));
  app.use("/{*path}", pageLimiter, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}

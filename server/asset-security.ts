import type { RequestOptions } from "node:http";
import rateLimit from "express-rate-limit";

// Only the path is client-controlled. Never parse it as a complete URL.
export function glyphRequestOptions(requestPath: string): RequestOptions | null {
  if (requestPath.length > 4096) return null;
  const match = /^\/([^/]+)\/(\d+)-(\d+)\.pbf$/.exec(requestPath);
  if (!match) return null;
  let font: string;
  try { font = decodeURIComponent(match[1]); } catch { return null; }
  if (!/^[\p{L}\p{N} ,_.-]{1,256}$/u.test(font) || font === "." || font === "..") return null;
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || start < 0 || start % 256 !== 0 || end !== start + 255 || end > 65535) return null;
  return {
    protocol: "https:", hostname: "protomaps.github.io", port: 443, method: "GET",
    path: `/basemaps-assets/fonts/${encodeURIComponent(font)}/${start}-${end}.pbf`,
  };
}

export function tileRequestOptions(requestPath: string, production: boolean): RequestOptions | null {
  if (requestPath.length > 4096) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(requestPath); } catch { return null; }
  if (!/^\/[a-zA-Z0-9_./@-]+$/.test(decoded)) return null;
  const parts = decoded.slice(1).split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return {
    protocol: "http:", hostname: production ? "host.docker.internal" : "localhost",
    port: 8080, method: "GET", path: "/" + parts.map(encodeURIComponent).join("/"),
  };
}

// Separate budgets: map traffic must not consume the SPA navigation budget.
// Defaults are per process/IP; upstream nginx still needs its own protection.
export function createAssetLimiter(max = 600) {
  return rateLimit({
    windowMs: 60_000, max, standardHeaders: true, legacyHeaders: false,
    skip: () => process.env.NODE_ENV !== "production" && process.env.DISABLE_RATE_LIMIT === "1",
    message: { error: "Слишком много запросов. Попробуйте позже." },
  });
}

export const mapAssetLimiter = createAssetLimiter(600);
export const staticAssetLimiter = createAssetLimiter(600);
export const pageLimiter = createAssetLimiter(120);

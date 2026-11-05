import type { Express, Request, Response } from "express";
import * as fs from "fs";
import * as nodePath from "path";
import * as https from "https";
import * as http from "http";
import * as zlib from "zlib";
import { logger } from "../logger";
import { glyphRequestOptions, tileRequestOptions, mapAssetLimiter } from "../asset-security";

// PMTiles fallback for dev/CI and hosts without nginx file serving.
// Keep Range responses and stream error/abort handling intact.
function servePmtiles(fileName: string) {
  return (req: Request, res: Response): void => {
    const filePath = nodePath.join("/app/osm", fileName);
    let fileSize: number;
    try {
      fileSize = fs.statSync(filePath).size;
    } catch {
      res.status(404).end();
      return;
    }
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = fileSize - 1;
    let isPartial = false;
    if (typeof rangeHeader === "string") {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      const parsedStart = match ? parseInt(match[1], 10) : NaN;
      const parsedEnd = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const valid = match !== null && Number.isFinite(parsedStart) &&
        Number.isFinite(parsedEnd) && parsedStart <= parsedEnd && parsedStart < fileSize;
      if (!valid) {
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        res.status(416).end();
        return;
      }
      start = parsedStart;
      end = Math.min(parsedEnd, fileSize - 1);
      isPartial = true;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=86400");
    const stream = fs.createReadStream(filePath, isPartial ? { start, end } : undefined);
    stream.on("error", (err: NodeJS.ErrnoException) => {
      logger.warn({ err, filePath }, "pmtiles fallback: read stream error");
      if (!res.headersSent) res.status(err.code === "ENOENT" ? 404 : 500).end();
      else res.destroy();
    });
    res.on("close", () => stream.destroy());
    if (isPartial) {
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", end - start + 1);
      res.status(206);
    } else {
      res.setHeader("Content-Length", fileSize);
      res.status(200);
    }
    stream.pipe(res);
  };
}

export function registerTileRoutes(app: Express): void {
  app.get("/kaliningrad.pmtiles", mapAssetLimiter, servePmtiles("kaliningrad.pmtiles"));
  app.get("/addresses.pmtiles", mapAssetLimiter, servePmtiles("addresses.pmtiles"));
  app.get("/addresses-v2.pmtiles", mapAssetLimiter, servePmtiles("addresses-v2.pmtiles"));

  // Fixed authority, validated font/range, and no automatic redirect following.
  app.use("/glyphs", mapAssetLimiter, (req: Request, res: Response) => {
    const options = glyphRequestOptions(req.path);
    if (!options) { res.status(400).end(); return; }
    const proxyReq = https.get(options, (proxyRes) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      proxyRes.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          proxyRes.destroy();
          proxyReq.destroy(new Error("Glyph response exceeds 2 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      proxyRes.on("error", () => { if (!res.headersSent) res.status(502).end(); });
      proxyRes.on("end", () => {
        if (res.writableEnded || res.destroyed) return;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=604800");
        res.setHeader("Content-Type", "application/x-protobuf");
        res.status(proxyRes.statusCode ?? 200).end(Buffer.concat(chunks));
      });
    });
    proxyReq.setTimeout(10_000, () => proxyReq.destroy(new Error("Glyph upstream timeout")));
    proxyReq.on("error", () => { if (!res.headersSent) res.status(502).end(); });
    res.on("close", () => proxyReq.destroy());
  });

  app.use("/tiles", mapAssetLimiter, (req: Request, res: Response) => {
    const options = tileRequestOptions(req.path, process.env.NODE_ENV === "production");
    if (!options) { res.status(400).end(); return; }
    const tilePath = options.path!;
    const isTileJson = tilePath.endsWith(".json");
    const proxyReq = http.request(options, (proxyRes) => {
      const ct = proxyRes.headers["content-type"] ?? "application/octet-stream";
      const ce = proxyRes.headers["content-encoding"];
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=86400");
      proxyRes.on("error", () => { if (!res.headersSent) res.status(502).end(); });
      if (isTileJson) {
        // Preserve TileJSON decompression and same-origin URL rewriting.
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const raw = Buffer.concat(chunks);
          const decode = (buf: Buffer): Promise<Buffer> =>
            ce === "gzip" || ce === "deflate"
              ? new Promise((ok, fail) => zlib.gunzip(buf, (err, r) => err ? fail(err) : ok(r)))
              : Promise.resolve(buf);
          decode(raw).then((buf) => {
            if (res.writableEnded || res.destroyed) return;
            try {
              const json = JSON.parse(buf.toString("utf8"));
              const fwdProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
              const fwdHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
              const proto = fwdProto || req.protocol || "https";
              const host = fwdHost || req.get("host") || process.env.PUBLIC_HOST || "takeride.ru";
              const origin = `${proto}://${host}`;
              const rewrite = (url: string) => `${origin}${url.replace(/^https?:\/\/[^/]+/, "/tiles")}`;
              if (Array.isArray(json.tiles)) json.tiles = (json.tiles as string[]).map(rewrite);
              if (Array.isArray(json.grids)) json.grids = (json.grids as string[]).map(rewrite);
              res.setHeader("Content-Type", "application/json");
              res.status(proxyRes.statusCode ?? 200).end(JSON.stringify(json));
            } catch {
              res.setHeader("Content-Type", ct);
              if (ce) res.setHeader("Content-Encoding", ce);
              res.status(proxyRes.statusCode ?? 200).end(raw);
            }
          }).catch(() => {
            if (res.writableEnded || res.destroyed) return;
            res.setHeader("Content-Type", ct);
            if (ce) res.setHeader("Content-Encoding", ce);
            res.status(proxyRes.statusCode ?? 200).end(raw);
          });
        });
      } else {
        logger.debug({ tilePath, status: proxyRes.statusCode, ct, ce, headers: proxyRes.headers }, "[tile-proxy] response");
        if (ce) res.setHeader("Content-Encoding", ce);
        res.setHeader("Content-Type", ct);
        const tileChunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => tileChunks.push(chunk));
        proxyRes.on("end", () => {
          if (res.writableEnded || res.destroyed) return;
          const body = Buffer.concat(tileChunks);
          logger.debug({ tilePath, bytes: body.length }, "[tile-proxy] body");
          res.status(proxyRes.statusCode ?? 200).end(body);
        });
      }
    });
    proxyReq.setTimeout(10_000, () => proxyReq.destroy(new Error("Tile upstream timeout")));
    proxyReq.on("error", (err: unknown) => {
      logger.error({ err }, "[tile-proxy] error");
      if (!res.headersSent) res.status(502).end();
      else if (!res.writableEnded) res.destroy();
    });
    res.on("close", () => proxyReq.destroy());
    proxyReq.end();
  });
}

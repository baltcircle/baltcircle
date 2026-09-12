import type { Express, Request, Response } from "express";
import * as fs from "fs";
import * as nodePath from "path";
import * as https from "https";
import * as http from "http";
import * as zlib from "zlib";
import { storage } from "../storage";
import { z } from "zod";
import { TARIFFS, tariffPriceKopecks } from "@shared/geo";
import {
  insertMapObjectSchema, otpStartSchema, otpVerifySchema, updateProfileSchema,
  adminSetRoleSchema, adminSetBlockedSchema,
  phoneChangeStartSchema, phoneChangeVerifySchema,
  linkPaymentMethodSchema, createSupportTicketSchema, rideInitPaymentSchema,
  rideChargeSavedCardSchema,
  adminCreateBikeSchema, adminUpdateBikeSchema,
  createTicketSchema, updateTicketSchema, addTicketCommentSchema,
  adminCreateParkingSchema, adminUpdateParkingSchema, updateMapObjectSchema,
} from "@shared/schema";
import type { PaymentMethod, PaymentOrder, Ride } from "@shared/schema";
import { sendOtpSms, getSmsDiagnostics, smsProvider, getSigmaSmsSendingStatus } from "./../sms";
import {
  getTbankConfig, getTbankDiagnostics, isTbankConfigured, tbankAddCard,
  tbankGetAddCardState, classifyCardBinding, classifyInitBinding,
  verifyNotificationToken,
  tbankInitRidePayment, generateRideOrderId, classifyRidePayment,
  tbankInitSavedCardCharge, tbankCharge, generateSavedCardRideOrderId,
  tbankGetState,
  tbankAddAccountQr, tbankGetAddAccountQrState,
  generateSbpBindOrderId, extractQrPayload, classifyAccountBinding,
} from "./../tbank";
import type { TbankConfig } from "./../tbank";
import {
  startRideForPaidOrder, tbankErrorBody, handleTbankNotification,
  bindingErrorPatch, refundVerificationCharge, bindViaVerificationPayment,
  maskPan, cardBrand,
} from "./../payments/tbank-handlers";
import { log } from "./../index";
import { logger } from "./../logger";
import {
  riderId, isStaffSession, canManageRide, actorName, clientIp,
  requireRole, requireAuth, requireRoleWhenConfigured,
  otpLimiter, paymentLimiter,
} from "./context";

// ── PMTiles file serving (Range-request aware) ───────────────────────────────
// Serves a .pmtiles file from the mounted /app/osm volume. PMTiles protocol
// issues HTTP Range requests, so 206 partial responses are mandatory.
//
// audit HIGH #9: in production this handler is now a FALLBACK only. nginx
// (deploy/nginx/baltcircle.conf, `location ~ ^/(...)\.pmtiles$`) serves
// /kaliningrad.pmtiles and /addresses.pmtiles directly off the same host path
// Docker bind-mounts read-only into this container, so the 571 MB base map
// extract and every Range chunk MapLibre requests while panning/zooming never
// touch Node at all in prod — nginx's regex location wins over the catch-all
// proxy_pass before a request ever reaches here. This route stays registered
// because local/dev/CI (API_ONLY, `npm run dev`) run the app with no nginx in
// front of it at all, and it also serves as a safety net if the nginx config
// on a given host is ever out of date.
function servePmtiles(fileName: string) {
  return (req: Request, res: Response): void => {
    const filePath = nodePath.join("/app/osm", fileName);
    let fileSize: number;
    try {
      // statSync (not existsSync+statSync) collapses the check-then-use race
      // into one syscall — the file can still legitimately disappear between
      // this and createReadStream below (e.g. a concurrent atomic `mv` during
      // regen), which is why createReadStream also gets an error handler.
      fileSize = fs.statSync(filePath).size;
    } catch {
      res.status(404).end();
      return;
    }

    // audit HIGH #9 follow-up: an unvalidated Range header (garbage text,
    // reversed/out-of-bounds bytes, a suffix-range MapLibre never sends but
    // a hostile client could) used to flow straight into parseInt and then
    // into Content-Range/Content-Length — `NaN` there is a malformed
    // response, not a clean error. Validate strictly per RFC 7233 and
    // answer 416 with the required Content-Range: */size on anything else.
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = fileSize - 1;
    let isPartial = false;
    if (typeof rangeHeader === "string") {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      const parsedStart = match ? parseInt(match[1], 10) : NaN;
      const parsedEnd = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const valid =
        match !== null &&
        Number.isFinite(parsedStart) &&
        Number.isFinite(parsedEnd) &&
        parsedStart <= parsedEnd &&
        parsedStart < fileSize;
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
    // A Readable's 'error' event has no default handler in Node — left
    // unhandled it crashes the whole process, taking every other in-flight
    // request down with it. Triggers include the underlying file being
    // swapped mid-read (the same regen race guarded against above) and a
    // mobile client dropping the connection mid-Range-read while panning.
    stream.on("error", (err: NodeJS.ErrnoException) => {
      logger.warn({ err, filePath }, "pmtiles fallback: read stream error");
      if (!res.headersSent) {
        res.status(err.code === "ENOENT" ? 404 : 500).end();
      } else {
        res.destroy();
      }
    });
    // Client aborted (e.g. fast pan cancels an in-flight Range fetch) — stop
    // reading instead of leaking the file descriptor to completion.
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
  // Base map tiles (571 MB Protomaps extract) + address overlay (~1 MB OSM housenumbers).
  app.get("/kaliningrad.pmtiles", servePmtiles("kaliningrad.pmtiles"));
  app.get("/addresses.pmtiles", servePmtiles("addresses.pmtiles"));

  // ── OSM Tile Proxy (legacy fallback — kept while tileserver still runs) ──
  // Proxies /tiles/* to local tileserver-gl (port 8080).
  // ── MapLibre Font Proxy ──────────────────────────────────────────────────
  // Proxies /glyphs/{fontstack}/{range}.pbf → protomaps GitHub Pages CDN.
  // Serving fonts same-origin avoids CORS issues in iOS WKWebView.
  app.use("/glyphs", (req: Request, res: Response) => {
    const upstream = `https://protomaps.github.io/basemaps-assets/fonts${req.path}`;
    const proxyReq = https.get(upstream, (proxyRes) => {
      const chunks: Buffer[] = [];
      proxyRes.on("data", (c: Buffer) => chunks.push(c));
      proxyRes.on("end", () => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=604800"); // 1 week
        res.setHeader("Content-Type", "application/x-protobuf");
        res.status(proxyRes.statusCode ?? 200).end(Buffer.concat(chunks));
      });
    });
    proxyReq.on("error", () => { if (!res.headersSent) res.status(502).end(); });
  });

  app.use("/tiles", (req: Request, res: Response) => {
    const tilePath = req.path; // e.g. "/data/kaliningrad.json"
    const tileHost = process.env.NODE_ENV === "production" ? "host.docker.internal" : "localhost";
    const upstreamUrl = `http://${tileHost}:8080${tilePath}`;
    const upstream = new URL(upstreamUrl);
    const isTileJson = tilePath.endsWith(".json");

    const proxyReq = http.request(
      {
        hostname: upstream.hostname,
        port: Number(upstream.port) || 8080,
        path: upstream.pathname + upstream.search,
        method: "GET",
      },
      (proxyRes) => {
        const ct = proxyRes.headers["content-type"] ?? "application/octet-stream";
        const ce = proxyRes.headers["content-encoding"];
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=86400");

        if (isTileJson) {
          // Buffer TileJSON (possibly gzip-encoded) and rewrite tile/grid URLs to absolute.
          // MapLibre GL requires absolute URLs in tiles[] — relative URLs keep source in
          // "loading" state indefinitely. Handle gzip via zlib.gunzip.
          const chunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on("end", () => {
            const raw = Buffer.concat(chunks);
            const decode = (buf: Buffer): Promise<Buffer> =>
              ce === "gzip" || ce === "deflate"
                ? new Promise((ok, fail) => zlib.gunzip(buf, (err, r) => err ? fail(err) : ok(r)))
                : Promise.resolve(buf);

            decode(raw).then((buf) => {
              try {
                const json = JSON.parse(buf.toString("utf8"));
                // Resolve public origin behind nginx reverse proxy
                const fwdProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
                const fwdHost  = (req.headers["x-forwarded-host"]  as string | undefined)?.split(",")[0]?.trim();
                const proto  = fwdProto || req.protocol || "https";
                const host   = fwdHost  || req.get("host") || process.env.PUBLIC_HOST || "takeride.ru";
                const origin = `${proto}://${host}`;
                const rewrite = (url: string) => `${origin}${url.replace(/^https?:\/\/[^/]+/, "/tiles")}`;
                if (Array.isArray(json.tiles)) json.tiles = (json.tiles as string[]).map(rewrite);
                if (Array.isArray(json.grids)) json.grids = (json.grids as string[]).map(rewrite);
                res.setHeader("Content-Type", "application/json");
                // Never forward Content-Encoding — we're sending decompressed JSON
                res.status(proxyRes.statusCode ?? 200).end(JSON.stringify(json));
              } catch {
                res.setHeader("Content-Type", ct);
                if (ce) res.setHeader("Content-Encoding", ce);
                res.status(proxyRes.statusCode ?? 200).end(raw);
              }
            }).catch(() => {
              res.setHeader("Content-Type", ct);
              if (ce) res.setHeader("Content-Encoding", ce);
              res.status(proxyRes.statusCode ?? 200).end(raw);
            });
          });
        } else {
          // Log tile proxy response for debugging
          logger.debug({ tilePath, status: proxyRes.statusCode, ct, ce, headers: proxyRes.headers }, "[tile-proxy] response");
          if (ce) res.setHeader("Content-Encoding", ce);
          res.setHeader("Content-Type", ct);
          // Buffer tile and forward — avoids pipe issues with some proxy setups
          const tileChunks: Buffer[] = [];
          proxyRes.on("data", (chunk: Buffer) => tileChunks.push(chunk));
          proxyRes.on("end", () => {
            const body = Buffer.concat(tileChunks);
            logger.debug({ tilePath, bytes: body.length }, "[tile-proxy] body");
            res.status(proxyRes.statusCode ?? 200).end(body);
          });
        }
      }
    );
    proxyReq.on("error", (err: unknown) => {
      logger.error({ err }, "[tile-proxy] error");
      if (!res.headersSent) res.status(502).end();
    });
    proxyReq.end();
  });
}

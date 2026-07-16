import type { Express, Request, Response } from "express";
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
function servePmtiles(fileName: string) {
  return (req: Request, res: Response): void => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const filePath = path.join("/app/osm", fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const rangeHeader = req.headers.range;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=86400");
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", chunkSize);
      res.status(206);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", fileSize);
      res.status(200);
      fs.createReadStream(filePath).pipe(res);
    }
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
    const https = require("https") as typeof import("https");
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
    const http = require("http") as typeof import("http");
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
          const zlib = require("zlib") as typeof import("zlib");
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

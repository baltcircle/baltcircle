import type { Express } from "express";
import { EventEmitter } from "node:events";
import { ADMIN_TOPICS, type AdminTopic } from "@shared/admin-data";
import { SSE_HEARTBEAT_INTERVAL_MS } from "@shared/geo";
import { storage } from "../storage";
import { bikeEvents, BIKE_EVENT_CHANNEL, fleetDataEvents, publicCatalogEvents } from "../storage/events";
import { requireRole } from "./context";
import { mutationTopics } from "./admin-live-policy";

const events = new EventEmitter();
events.setMaxListeners(0);

export function registerAdminLiveRoutes(app: Express) {
  // Must be installed before mutation handlers. finish fires only after their
  // awaited persistence and final HTTP response, never before a transaction.
  app.use((req, res, next) => {
    res.once("finish", () => {
      const topics = mutationTopics(req.method, req.path, res.statusCode);
      if (topics.length) events.emit("change", topics);
      if (topics.includes("parkings") || topics.includes("map")) publicCatalogEvents.emit("change");
    });
    next();
  });
  app.get("/api/admin/events", requireRole("mechanic", "operator", "admin"), (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<AdminTopic>();
    const push = (topics: AdminTopic[]) => {
      if (closed) return;
      topics.forEach((topic) => pending.add(topic));
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed) res.write(`data: ${JSON.stringify({ topics: Array.from(pending) })}\n\n`);
        pending.clear();
      }, 250);
    };
    const fleet = () => push(["fleet", "rides"]);
    const telemetry = () => push(["fleet"]);
    events.on("change", push);
    bikeEvents.on(BIKE_EVENT_CHANNEL, fleet);
    fleetDataEvents.on("telemetry", telemetry);
    // Initial/reconnect snapshot invalidation recovers all missed events.
    push(ADMIN_TOPICS);
    let checking = false;
    const heartbeat = setInterval(async () => {
      if (checking || closed) return;
      checking = true;
      try {
        await new Promise<void>((resolve, reject) => req.session.reload((error) => error ? reject(error) : resolve()));
        const user = await storage.getUser(req.session!.userId!);
        if (!user || user.blockedAt || !["mechanic", "operator", "admin"].includes(user.role)) {
          res.end();
          return;
        }
        if (!closed) res.write(`event: heartbeat\ndata: {}\n\n`);
      } catch {
        res.end();
      } finally { checking = false; }
    }, SSE_HEARTBEAT_INTERVAL_MS);
    res.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(timer);
      events.off("change", push);
      bikeEvents.off(BIKE_EVENT_CHANNEL, fleet);
      fleetDataEvents.off("telemetry", telemetry);
    });
  });
}

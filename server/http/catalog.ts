import type { Express, Request, Response } from "express";
import { storage, bikeEvents, BIKE_EVENT_CHANNEL } from "../storage";
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
  adminCreateLockSchema, adminUpdateLockSchema,
} from "@shared/schema";
import type { Bike, BikeStatus, PaymentMethod, PaymentOrder, Ride } from "@shared/schema";
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
import { getLockGateway } from "../omni/gateway";
import {
  riderId, isStaffSession, canManageRide, actorName, clientIp,
  requireRole, requireAuth, requireRoleWhenConfigured,
  otpLimiter, paymentLimiter, parsePageParams,
} from "./context";

// The OMNI lock's onboard shake/tamper sensor only arms while the shackle is
// closed (confirmed empirically on a live test lock; the vendor protocol,
// checked against its published spec, documents no remote arm/disarm or mute
// command for the W0 illegal-movement alarm at all). The only lever the
// software has is unlocking the shackle before staff move the bike — that
// opens it, which disarms the sensor as a side effect. Deliberately excludes
// "lost": for a lost bike, alarming on movement is exactly the point.
//
// Deliberately excludes "offline" too (rental spec addendum, 2026-09): a bike
// can now reach "offline" automatically on low battery (server/omni/store.ts,
// server/storage/ride.ts) with the lock never told to open, and this same set
// also drives the operator-initiated PATCH below — an admin manually flipping
// a bike to "offline" must get the identical no-unlock behaviour, or the two
// paths would silently disagree on whether "offline" ever pops the shackle.
// Staff who genuinely need the physical lock open on an offline bike (e.g. to
// retrieve/recharge it) still have the explicit /api/admin/locks/:id/unlock
// control below, unaffected by this set.
//
// Also deliberately excludes "storage" (bike-status lifecycle audit,
// 2026-09): a bike parked in storage — including one an operator has put to
// sleep via the OMNI lock's vendor app — must stay physically locked; auto-
// unlocking it here was a bug (it would pop its shackle open on every status
// write), not a deliberate convenience like the ones below.
const MOVEMENT_ALARM_SUPPRESSED_STATUSES: ReadonlySet<string> = new Set(
  ["maintenance", "archived"] satisfies BikeStatus[],
);

// Fire-and-forget, mirroring the GPS-refresh call beside it: never blocks the
// PATCH response on lock I/O, and any failure (lock offline, no gateway, lock
// declines) is merely logged — this is a best-effort convenience, not a
// guaranteed disarm. Refuses to unlock a bike mid-ride for safety, mirroring
// the F-07 guard on the manual /api/admin/locks/:id/unlock endpoint: an admin
// archiving/offlining a bike must never silently pop the lock out from under
// an active renter (that case would be a data bug elsewhere, but we don't
// trust it here).
async function suppressMovementAlarmOnStatusChange(bike: Bike): Promise<void> {
  if (!bike.lockImei) return;
  const activeRide = await storage.getActiveRideForBike(bike.id);
  if (activeRide) {
    log(
      `movement-alarm suppression skipped: bike ${bike.id} -> ${bike.status} has active ride ${activeRide.id}`,
    );
    return;
  }
  try {
    // userId is an opaque wire value here (echoed back for logging only, see
    // resolveUnlock in server/omni/server.ts) — 0 marks "system, no rider".
    const result = await getLockGateway()?.sendUnlockCommand(bike.lockImei, 0);
    if (result && !result.success) {
      log(`movement-alarm suppression: lock ${bike.lockImei} (bike ${bike.id}) declined unlock`);
    }
  } catch (err) {
    log(
      `movement-alarm suppression failed for bike ${bike.id} (${bike.lockImei}): ${(err as Error).message}`,
    );
  }
}

// Statuses that take a bike out of rotation and must never be visible to an
// ordinary rider on the public map/list — regardless of who they are — since
// they carry no rider-facing meaning ("Сервис", "Оффлайн", "На складе",
// "Утерян"). Staff keep full visibility via /api/admin/bikes.
const RIDER_HIDDEN_STATUSES: ReadonlySet<string> = new Set(
  ["maintenance", "offline", "storage", "lost"] satisfies BikeStatus[],
);

// Filters the full fleet down to what a given (possibly anonymous — riderId()
// falls back to the shared "demo" account) rider is allowed to see:
//  - "available" bikes are visible to everyone.
//  - a bike this rider currently has "rented" or "reserved" stays visible to
//    THEM (so their own map/QR flow keeps working) but disappears for anyone
//    else — other riders must not see a bike is in use / who's near it.
//  - out-of-rotation statuses (maintenance/offline/storage/lost) are
//    hidden from every rider; only staff need to see those on a map.
//  - "archived" is already excluded by storage.listBikes().
async function filterBikesForRider(bikes: Bike[], req: Request): Promise<Bike[]> {
  const uid = riderId(req);
  const [myRide, myReservation] = await Promise.all([
    storage.getActiveRide(uid),
    storage.getActiveReservationForUser(uid),
  ]);
  return bikes.filter((b) => {
    if (b.status === "available") return true;
    if (b.status === "rented") return myRide?.bikeId === b.id;
    if (b.status === "reserved") return myReservation?.bikeId === b.id;
    return !RIDER_HIDDEN_STATUSES.has(b.status);
  });
}

export function registerCatalogRoutes(app: Express): void {
  // -------------- Bikes / Parkings / Zones --------------
  // Public read: archived bikes are excluded so they never reach the map or
  // rental selection. (The admin fleet page uses /api/admin/bikes for the full
  // list including archived.) Staff sessions (used by the admin dashboard,
  // maintenance and rides-admin pages, which all reuse this same endpoint)
  // get the unfiltered fleet; everyone else gets filterBikesForRider() applied
  // so a rider can never see another rider's rented/reserved bike or any
  // out-of-rotation bike on the map/QR flow (bike-status lifecycle audit).
  app.get("/api/bikes", async (req, res) => {
    const all = await storage.listBikes();
    if (await isStaffSession(req)) return res.json(all);
    res.json(await filterBikesForRider(all, req));
  });

  // SSE-стрим флота: сервер шлёт событие "tick" при любом изменении
  // статуса/набора велосипедов. Клиент по этому событию инвалидирует
  // список. Общий broadcast (не per-user) — один канал на весь флот.
  // Публичный (без роли): карта тоже слушает, чтобы обновлять метки.
  app.get("/api/bikes/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();
    let closed = false;
    const onTick = () => { if (!closed) res.write(`data: tick\n\n`); };
    bikeEvents.on(BIKE_EVENT_CHANNEL, onTick);
    // Начальный пинг, чтобы клиент сразу подтянул актуальное состояние.
    res.write(`data: tick\n\n`);
    const heartbeat = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, 25000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      bikeEvents.off(BIKE_EVENT_CHANNEL, onTick);
    };
    req.on("close", cleanup);
    res.on("error", cleanup);
  });

  app.get("/api/bikes/:id", async (req, res) => {
    const b = await storage.getBike(req.params.id);
    if (!b) return res.status(404).json({ error: "Велосипед не найден" });
    res.json(b);
  });
  // NOTE: there is intentionally no public PATCH /api/bikes/:id. Bike mutations
  // go through the staff-guarded PATCH /api/admin/bikes/:id (validated +
  // role-checked). An unguarded public PATCH passing req.body straight to
  // updateBike was an unauthenticated mass-assignment hole and has been removed.
  // Public read: only active, non-archived parking points reach the customer
  // app. The admin page uses /api/admin/parkings for the full list.
  app.get("/api/parkings", async (_req, res) => res.json(await storage.listParkings()));

  // -------------- Admin: parking management --------------
  // Staff-only CRUD over parking points. The list includes inactive + archived
  // points so operators can see/restore them; the public /api/parkings never does.
  app.get("/api/admin/parkings", requireRole("operator", "admin"), async (_req, res) => {
    res.json(await storage.listParkings({ includeInactive: true, includeArchived: true }));
  });
  app.post("/api/admin/parkings", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminCreateParkingSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.createParking(parsed.data);
    if ("error" in result) return res.status(409).json(result);
    res.status(201).json(result.parking);
  });
  app.patch("/api/admin/parkings/:id", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminUpdateParkingSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.updateParking(String(req.params.id), parsed.data);
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  app.post("/api/admin/parkings/:id/archive", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.archiveParking(String(req.params.id));
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  // Restore returns an archived point as *inactive* so it never re-appears on
  // the public map until an operator activates it; it shows muted on admin maps.
  app.post("/api/admin/parkings/:id/restore", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.restoreParking(String(req.params.id));
    if ("error" in result) return res.status(404).json(result);
    res.json(result.parking);
  });
  app.delete("/api/admin/parkings/:id", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.deleteParking(String(req.params.id));
    if ("error" in result) {
      // Parking kept but archived (bikes referenced it) → 409 with archived row.
      if (result.archived) return res.status(409).json(result);
      return res.status(404).json(result);
    }
    res.json(result);
  });

  // -------------- Admin: fleet (bike) management --------------
  // Staff-only CRUD over the real fleet. The list includes archived bikes so
  // operators can see/restore them; the public /api/bikes never does.
  // Read access includes mechanics so the service staff can see the full fleet
  // (including archived) while triaging tickets; writes below stay operator/admin.
  app.get("/api/admin/bikes", requireRole("mechanic", "operator", "admin"), async (req, res) => {
    // listBikes is cached and shared by the map/analytics, so paginate the
    // already-loaded list here rather than in the storage layer (audit M5).
    const all = await storage.listBikes({ includeArchived: true });
    res.setHeader("X-Total-Count", String(all.length));
    const { limit, offset } = parsePageParams(req);
    res.json(limit !== undefined ? all.slice(offset, offset + limit) : all);
  });
  app.post("/api/admin/bikes", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminCreateBikeSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.createBike(parsed.data);
    if ("error" in result) return res.status(409).json(result);
    res.status(201).json(result.bike);
  });
  app.patch("/api/admin/bikes/:id", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminUpdateBikeSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.adminUpdateBike(String(req.params.id), parsed.data);
    if ("error" in result) {
      // A lock taken by another bike is a conflict, not a missing bike.
      const status = (result.error ?? "").includes("не найден") ? 404 : 409;
      return res.status(status).json(result);
    }
    // GPS-interval sync (fire-and-forget, bike-status lifecycle spec,
    // 2026-09): every status maps to a persistent, non-zero D1 tracking
    // interval — only relevant when this PATCH actually changed status.
    if (parsed.data.status !== undefined && result.bike.lockImei) {
      getLockGateway()?.syncGpsTrackingForStatus(result.bike.lockImei, result.bike.id, result.bike.status as BikeStatus);
      // See suppressMovementAlarmOnStatusChange: unlock so staff can move the
      // bike into these out-of-rotation statuses without the lock's own
      // shake-sensor siren going off.
      if (MOVEMENT_ALARM_SUPPRESSED_STATUSES.has(result.bike.status)) {
        void suppressMovementAlarmOnStatusChange(result.bike);
      }
    }
    res.json(result.bike);
  });

  // -------------- Admin: smart lock discovery --------------
  // Any registry lock not fitted to a bike is eligible for selection. Connectivity
  // is deliberately not part of binding eligibility: a lock may be active,
  // installed, unregistered, or offline while awaiting installation.
  app.get("/api/admin/locks/unassigned", requireRole("operator", "admin"), async (_req, res) => {
    res.json(await storage.listUnassignedLocks());
  });

  // A lock that has dialled into the OMNI gateway but has no registry row yet
  // (see server/storage/bike.ts:listDiscoveredLocks). Lets an operator learn a
  // brand-new lock's IMEI and register it right after powering it on.
  app.get("/api/admin/locks/discovered", requireRole("operator", "admin"), async (_req, res) => {
    res.json(await storage.listDiscoveredLocks());
  });

  // -------------- Admin: lock device registry (Phase 1) --------------
  // This only owns registered-device metadata. The OMNI TCP gateway is
  // intentionally outside this API and will update telemetry in a later phase.
  app.get("/api/admin/locks", requireRole("operator", "admin"), async (_req, res) => {
    res.json(await storage.listLocks());
  });
  app.post("/api/admin/locks", requireRole("operator", "admin"), async (req, res) => {
    const parsed = adminCreateLockSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.createLock(parsed.data);
    if ("error" in result) return res.status(result.error.includes("IMEI") ? 409 : 404).json(result);
    // Mirror of the decommission-path revokeImei() calls below: this IMEI may
    // already be negative-cached as "unknown" in the running gateway from an
    // earlier, pre-registration dial-in (that rejection is exactly what put
    // it in the discovered-locks list in the first place) — without busting
    // that cache entry here, the device's reconnect attempts keep getting
    // rejected against the stale verdict for up to IMEI_NEGATIVE_TTL_MS after
    // this registration, so no telemetry (including GPS) reaches the server.
    getLockGateway()?.admitImei(result.lock.imei);
    res.status(201).json(result.lock);
  });
  // Pilot-only operational control. The TCP process keeps the live socket
  // registry, so a request is deliberately refused rather than queued if the
  // particular lock is not currently connected.
  app.post("/api/admin/locks/:id/unlock", requireRole("operator", "admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: "Замок не найден" });
    const lock = await storage.getLock(id);
    if (!lock) return res.status(404).json({ error: "Замок не найден" });
    const gateway = getLockGateway();
    if (!gateway) return res.status(503).json({ error: "Шлюз замков недоступен" });
    const userId = z.coerce.string().regex(/^\d{1,10}$/).safeParse(req.body?.userId);
    if (!userId.success) return res.status(400).json({ error: "Укажите числовой ID пользователя замка" });
    // F-07: a bike mid-ride for a different rider must not be silently opened
    // by this pilot-only control. `force: true` is an explicit, logged override
    // for genuine ops situations (stuck lock, support call), never the default.
    if (lock.bikeId) {
      const activeRide = await storage.getActiveRideForBike(lock.bikeId);
      if (activeRide && activeRide.userId !== userId.data && req.body?.force !== true) {
        log(
          `manual lock unlock refused: lock ${id} bike ${lock.bikeId} has active ride ${activeRide.id} ` +
          `for user ${activeRide.userId}, requested userId ${userId.data} without force`,
        );
        return res.status(409).json({
          error: "На велосипеде активна чужая поездка. Повторите запрос с force=true, если это осознанное решение",
          activeRideId: activeRide.id,
        });
      }
    }
    try {
      const result = await gateway.sendUnlockCommand(lock.imei, userId.data);
      if (!result.success) return res.status(409).json({ error: "Замок отклонил разблокировку" });
      res.json({ ok: true });
    } catch (err) {
      log(`manual lock unlock failed: ${(err as Error).message}`);
      res.status(503).json({ error: "Замок не подключен или не ответил" });
    }
  });
  app.patch("/api/admin/locks/:id", requireRole("operator", "admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: "Замок не найден" });
    const parsed = adminUpdateLockSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Проверьте введённые данные";
      return res.status(400).json({ error: msg });
    }
    const result = await storage.updateLock(id, parsed.data);
    if ("error" in result) return res.status(404).json(result);
    // Audit F-09: a PATCH can decommission a lock too, not just DELETE below
    // — either path must cut off an already-connected socket immediately
    // rather than waiting for it to disconnect on its own.
    if (result.lock.status === "decommissioned") getLockGateway()?.revokeImei(result.lock.imei);
    res.json(result.lock);
  });
  app.delete("/api/admin/locks/:id", requireRole("operator", "admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: "Замок не найден" });
    const result = await storage.decommissionLock(id);
    if ("error" in result) return res.status(404).json(result);
    // Audit F-09: decommission alone does not disconnect a live socket —
    // without this the retired/stolen device keeps reporting telemetry and
    // stays reachable by sendUnlockCommand() until it disconnects on its own.
    getLockGateway()?.revokeImei(result.lock.imei);
    res.json(result.lock);
  });

  // -------------- Admin: fleet alerts (fall-alarm dashboard notification) --------------
  // See server/storage/alert.ts + storage.ts's LOCK_FALL_ALARM bridge for how
  // rows land here. Read-only for mechanics; only operator/admin can ack.
  app.get("/api/admin/alerts", requireRole("mechanic", "operator", "admin"), async (_req, res) => {
    res.json(await storage.listAlerts());
  });
  app.post("/api/admin/alerts/:id/ack", requireRole("operator", "admin"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: "Алерт не найден" });
    const updated = await storage.acknowledgeAlert(id, await actorName(req));
    if (!updated) return res.status(404).json({ error: "Алерт не найден или уже подтверждён" });
    res.json(updated);
  });
  app.post("/api/admin/bikes/:id/archive", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.archiveBike(String(req.params.id));
    if ("error" in result) {
      const status = (result.error ?? "").includes("не найден") ? 404 : 400;
      return res.status(status).json(result);
    }
    // GPS-interval sync (fire-and-forget, bike-status lifecycle spec, 2026-09):
    // "archived" settles to the hourly out-of-rotation cadence.
    if (result.bike.lockImei) {
      getLockGateway()?.syncGpsTrackingForStatus(result.bike.lockImei, result.bike.id, "archived");
    }
    res.json(result.bike);
  });
  app.post("/api/admin/bikes/:id/restore", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.restoreBike(String(req.params.id));
    if ("error" in result) {
      const status = (result.error ?? "").includes("не найден") ? 404 : 400;
      return res.status(status).json(result);
    }
    // GPS-interval sync (fire-and-forget, mirrors the archive route above):
    // "offline" settles to its own out-of-rotation cadence. "offline" is
    // deliberately excluded from MOVEMENT_ALARM_SUPPRESSED_STATUSES (see the
    // comment above that set), so no unlock call is fired here.
    if (result.bike.lockImei) {
      getLockGateway()?.syncGpsTrackingForStatus(result.bike.lockImei, result.bike.id, "offline");
    }
    res.json(result.bike);
  });
  app.delete("/api/admin/bikes/:id", requireRole("operator", "admin"), async (req, res) => {
    const result = await storage.deleteBike(String(req.params.id));
    if ("error" in result) {
      // Bike kept but archived (had ride history) → 409 with the archived row.
      if (result.archived) return res.status(409).json(result);
      const status = (result.error ?? "").includes("не найден") ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  });
  // Permanent purge of an already-archived TEST bike (and its ride/ticket/
  // payment-order history) — admin-only. Stricter than the routes above:
  // operators can archive/attempt-delete, but only an admin may permanently
  // erase history, mirroring the admin-only account hard-delete route.
  app.post("/api/admin/bikes/:id/purge", requireRole("admin"), async (req, res) => {
    const result = await storage.purgeArchivedTestBike(String(req.params.id));
    if ("error" in result) {
      const status = result.error.includes("не найден") ? 404 : 400;
      return res.status(status).json(result);
    }
    res.json(result);
  });
  app.get("/api/zones", async (_req, res) => res.json(await storage.listZones()));
}

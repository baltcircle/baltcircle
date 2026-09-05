// Tests for the admin lock-discovery endpoint.
//
// A real Express app is mounted so the actual route and the real requireRole
// guard run; only the modules behind them (storage, SMS, T-Bank, the server
// entrypoint) are mocked, so the suite still needs no Postgres and no network
// (audit H5).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const storageMock = vi.hoisted(() => ({
  getUser: vi.fn(),
  listBikes: vi.fn(),
  listUnassignedLocks: vi.fn(),
  listDiscoveredLocks: vi.fn(),
  listLocks: vi.fn(),
  getLockStatesByImei: vi.fn(),
  createLock: vi.fn(),
  getLock: vi.fn(),
  updateLock: vi.fn(),
  decommissionLock: vi.fn(),
  getActiveRideForBike: vi.fn(),
  purgeArchivedTestBike: vi.fn(),
  restoreBike: vi.fn(),
  adminUpdateBike: vi.fn(),
  listAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(),
}));

vi.mock("../storage", () => ({
  storage: storageMock,
  bikeEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  BIKE_EVENT_CHANNEL: "fleet",
}));
vi.mock("../index", () => ({ log: vi.fn() }));
vi.mock("../sms", () => ({
  sendOtpSms: vi.fn(), getSmsDiagnostics: vi.fn(), smsProvider: "none",
  getSigmaSmsSendingStatus: vi.fn(),
}));
vi.mock("../push", () => ({ sendToUserAsync: vi.fn() }));

import { registerCatalogRoutes } from "./catalog";
import { setLockGateway } from "../omni/gateway";

// The session is normally installed by express-session; the guard only ever
// reads req.session.userId, so a test sets it directly via a header.
let sessionUserId: string | null = null;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).session = sessionUserId ? { userId: sessionUserId } : {};
  next();
});
registerCatalogRoutes(app);

let server: Server;
let baseUrl: string;

async function start(): Promise<void> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  setLockGateway(null);
  sessionUserId = null;
  storageMock.getLockStatesByImei.mockResolvedValue(new Map());
});

async function getLocks(): Promise<{ status: number; body: any }> {
  if (!server) await start();
  const res = await fetch(`${baseUrl}/api/admin/locks/unassigned`);
  return { status: res.status, body: await res.json() };
}

async function lockRequest(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
  if (!server) await start();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /api/admin/locks/unassigned", () => {
  it("requires a session", async () => {
    const res = await getLocks();

    expect(res.status).toBe(401);
    expect(storageMock.listUnassignedLocks).not.toHaveBeenCalled();
  });

  it("refuses a signed-in rider", async () => {
    sessionUserId = "u1";
    storageMock.getUser.mockResolvedValue({ id: "u1", role: "rider" });

    const res = await getLocks();

    expect(res.status).toBe(403);
    expect(storageMock.listUnassignedLocks).not.toHaveBeenCalled();
  });

  it("returns imei + lastSeen for an operator", async () => {
    sessionUserId = "u2";
    storageMock.getUser.mockResolvedValue({ id: "u2", role: "operator" });
    storageMock.listUnassignedLocks.mockResolvedValue([
      { imei: "861234567890123", lastSeen: 1_700_000_000_000 },
    ]);

    const res = await getLocks();

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ imei: "861234567890123", lastSeen: 1_700_000_000_000 }]);
  });

  it("asks storage for every eligible registry lock regardless of last-seen time", async () => {
    sessionUserId = "u3";
    storageMock.getUser.mockResolvedValue({ id: "u3", role: "admin" });
    storageMock.listUnassignedLocks.mockResolvedValue([]);

    await getLocks();

    expect(storageMock.listUnassignedLocks).toHaveBeenCalledWith();
  });
});

describe("GET /api/admin/locks/discovered", () => {
  async function getDiscovered(): Promise<{ status: number; body: any }> {
    if (!server) await start();
    const res = await fetch(`${baseUrl}/api/admin/locks/discovered`);
    return { status: res.status, body: await res.json() };
  }

  it("requires a session", async () => {
    const res = await getDiscovered();

    expect(res.status).toBe(401);
    expect(storageMock.listDiscoveredLocks).not.toHaveBeenCalled();
  });

  it("refuses a signed-in rider", async () => {
    sessionUserId = "u1";
    storageMock.getUser.mockResolvedValue({ id: "u1", role: "rider" });

    const res = await getDiscovered();

    expect(res.status).toBe(403);
    expect(storageMock.listDiscoveredLocks).not.toHaveBeenCalled();
  });

  it("returns imei + firstSeen + lastSeen for an operator", async () => {
    sessionUserId = "u2";
    storageMock.getUser.mockResolvedValue({ id: "u2", role: "operator" });
    storageMock.listDiscoveredLocks.mockResolvedValue([
      { imei: "861234567890123", firstSeen: 1_700_000_000_000, lastSeen: 1_700_000_100_000 },
    ]);

    const res = await getDiscovered();

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { imei: "861234567890123", firstSeen: 1_700_000_000_000, lastSeen: 1_700_000_100_000 },
    ]);
  });
});

describe("GET /api/admin/bikes", () => {
  it("includes the telemetry-owned lockLastSeen snapshot", async () => {
    sessionUserId = "operator-bike-list";
    storageMock.getUser.mockResolvedValue({ id: sessionUserId, role: "operator" });
    storageMock.listBikes.mockResolvedValue([{
      id: "BC-100",
      battery: 73,
      lockImei: "862596083776074",
      lockLastSeen: 1_700_000_000_000,
    }]);

    const res = await lockRequest("/api/admin/bikes");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({
      id: "BC-100",
      battery: 73,
      lockImei: "862596083776074",
      lockLastSeen: 1_700_000_000_000,
    })]);
    expect(storageMock.listBikes).toHaveBeenCalledWith({ includeArchived: true });
  });

  it("merges the live lock state next to each bike, keyed by its lock IMEI", async () => {
    sessionUserId = "operator-bike-list";
    storageMock.getUser.mockResolvedValue({ id: sessionUserId, role: "operator" });
    storageMock.listBikes.mockResolvedValue([
      { id: "BC-100", battery: 73, lockImei: "862596083776074" },
      { id: "BC-200", battery: 40, lockImei: "862596083776099" },
      { id: "BC-300", battery: 90, lockImei: null },
    ]);
    storageMock.getLockStatesByImei.mockResolvedValue(new Map([
      ["862596083776074", "locked"],
      // 862596083776099 intentionally absent — never reported yet.
    ]));

    const res = await lockRequest("/api/admin/bikes");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: "BC-100", lockState: "locked" }),
      expect.objectContaining({ id: "BC-200", lockState: null }),
      expect.objectContaining({ id: "BC-300", lockState: null }),
    ]);
    expect(storageMock.getLockStatesByImei).toHaveBeenCalledWith([
      "862596083776074", "862596083776099",
    ]);
  });
});

describe("lock device registry admin CRUD", () => {
  const operator = { id: "operator-1", role: "operator" };
  const registeredLock = {
    id: 7,
    imei: "861234567890123",
    bikeId: "BC-100",
    status: "installed",
    apn: "cmiot",
    lastLockState: null,
    lastLatitude: null,
    lastLongitude: null,
    lastLocationAt: null,
    bleKey: null,
    deviceTypeCode: null,
    lastAlarmType: null,
    lastAlarmAt: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  it("lists registered locks including null protocol telemetry", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.listLocks.mockResolvedValue([registeredLock]);

    const res = await lockRequest("/api/admin/locks");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([registeredLock]);
    expect(storageMock.listLocks).toHaveBeenCalledOnce();
  });

  it("registers a lock with IMEI required and keeps protocol telemetry gateway-owned", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.createLock.mockResolvedValue({ lock: registeredLock });

    const res = await lockRequest("/api/admin/locks", "POST", {
      imei: registeredLock.imei,
      bikeId: registeredLock.bikeId,
      status: registeredLock.status,
      lastLockState: "locked",
      lastLatitude: 54.7104,
      lastLongitude: 20.4522,
      lastLocationAt: 1_700_000_000_000,
      bleKey: "12345678",
      deviceTypeCode: "C4",
      lastAlarmType: "fall",
      lastAlarmAt: 1_700_000_000_000,
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(registeredLock);
    expect(storageMock.createLock).toHaveBeenCalledWith({
      imei: registeredLock.imei,
      bikeId: registeredLock.bikeId,
      status: registeredLock.status,
    });
  });

  it("rejects a duplicate IMEI with a conflict", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.createLock.mockResolvedValue({ error: "Замок с таким IMEI уже зарегистрирован" });

    const res = await lockRequest("/api/admin/locks", "POST", { imei: registeredLock.imei });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("IMEI");
  });

  // Regression (production incident, 2026-09-04): a device that dialled in
  // before being registered is negative-cached as "unknown" for
  // IMEI_NEGATIVE_TTL_MS; without busting that cache entry on registration,
  // its reconnects keep getting rejected against the stale verdict for up to
  // 5 minutes after this call, and no telemetry (GPS included) reaches the
  // server in the meantime.
  it("admits the newly registered IMEI into the gateway's auth cache", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.createLock.mockResolvedValue({ lock: registeredLock });
    const admitImei = vi.fn();
    setLockGateway({ admitImei } as any);

    const res = await lockRequest("/api/admin/locks", "POST", { imei: registeredLock.imei });

    expect(res.status).toBe(201);
    expect(admitImei).toHaveBeenCalledWith(registeredLock.imei);
  });

  it("does not fail lock registration when the gateway process is not running", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.createLock.mockResolvedValue({ lock: registeredLock });
    setLockGateway(null);

    const res = await lockRequest("/api/admin/locks", "POST", { imei: registeredLock.imei });

    expect(res.status).toBe(201);
  });

  it("sends an operator's manual unlock through the live gateway", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.getLock.mockResolvedValue(registeredLock);
    storageMock.getActiveRideForBike.mockResolvedValue(undefined);
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    setLockGateway({ sendUnlockCommand } as any);

    const res = await lockRequest("/api/admin/locks/7/unlock", "POST", { userId: "1234" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendUnlockCommand).toHaveBeenCalledWith(registeredLock.imei, "1234");
  });

  it("refuses a manual unlock when a different rider has an active ride on the bike (audit F-07)", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.getLock.mockResolvedValue(registeredLock);
    storageMock.getActiveRideForBike.mockResolvedValue({ id: 42, bikeId: "BC-100", userId: "rider-9", status: "active" });
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    setLockGateway({ sendUnlockCommand } as any);

    const res = await lockRequest("/api/admin/locks/7/unlock", "POST", { userId: "1234" });

    expect(res.status).toBe(409);
    expect(res.body.activeRideId).toBe(42);
    expect(sendUnlockCommand).not.toHaveBeenCalled();
  });

  it("allows a forced manual unlock despite a different rider's active ride (audit F-07)", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.getLock.mockResolvedValue(registeredLock);
    storageMock.getActiveRideForBike.mockResolvedValue({ id: 42, bikeId: "BC-100", userId: "rider-9", status: "active" });
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    setLockGateway({ sendUnlockCommand } as any);

    const res = await lockRequest("/api/admin/locks/7/unlock", "POST", { userId: "1234", force: true });

    expect(res.status).toBe(200);
    expect(sendUnlockCommand).toHaveBeenCalledWith(registeredLock.imei, "1234");
  });

  it("allows a manual unlock when the active ride belongs to the same rider (audit F-07)", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.getLock.mockResolvedValue(registeredLock);
    storageMock.getActiveRideForBike.mockResolvedValue({ id: 42, bikeId: "BC-100", userId: "1234", status: "active" });
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    setLockGateway({ sendUnlockCommand } as any);

    const res = await lockRequest("/api/admin/locks/7/unlock", "POST", { userId: "1234" });

    expect(res.status).toBe(200);
    expect(sendUnlockCommand).toHaveBeenCalledWith(registeredLock.imei, "1234");
  });

  it("returns not found when updating a missing lock", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.updateLock.mockResolvedValue({ error: "Замок не найден" });

    const res = await lockRequest("/api/admin/locks/999", "PATCH", { status: "offline" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Замок не найден" });
    expect(storageMock.updateLock).toHaveBeenCalledWith(999, { status: "offline" });
  });

  it("updates lock provisioning metadata", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    const patch = {
      simIccid: "8970101829255631812-9",
      apn: "cmiot",
      macAddress: "12:34:56:78:90:AB",
      firmwareVersion: "OC32_110",
    };
    storageMock.updateLock.mockResolvedValue({ lock: { ...registeredLock, ...patch } });

    const res = await lockRequest("/api/admin/locks/7", "PATCH", patch);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(patch);
    expect(storageMock.updateLock).toHaveBeenCalledWith(7, patch);
  });

  it("soft-deletes by moving a lock to decommissioned", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.decommissionLock.mockResolvedValue({
      lock: { ...registeredLock, status: "decommissioned" },
    });

    const res = await lockRequest("/api/admin/locks/7", "DELETE");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("decommissioned");
    expect(storageMock.decommissionLock).toHaveBeenCalledWith(7);
  });

  // Audit F-09: decommissioning must not just flip the DB row — it has to
  // reach the live OMNI gateway so an already-connected socket for that
  // lock is cut off immediately, not left running until it disconnects on
  // its own.
  it("revokes the gateway connection when a lock is decommissioned via DELETE", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.decommissionLock.mockResolvedValue({
      lock: { ...registeredLock, status: "decommissioned" },
    });
    const revokeImei = vi.fn();
    setLockGateway({ revokeImei } as any);

    const res = await lockRequest("/api/admin/locks/7", "DELETE");

    expect(res.status).toBe(200);
    expect(revokeImei).toHaveBeenCalledWith(registeredLock.imei);
  });

  it("revokes the gateway connection when a lock is decommissioned via PATCH", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.updateLock.mockResolvedValue({
      lock: { ...registeredLock, status: "decommissioned" },
    });
    const revokeImei = vi.fn();
    setLockGateway({ revokeImei } as any);

    const res = await lockRequest("/api/admin/locks/7", "PATCH", { status: "decommissioned" });

    expect(res.status).toBe(200);
    expect(revokeImei).toHaveBeenCalledWith(registeredLock.imei);
  });

  it("does not revoke anything for a PATCH that leaves the lock active", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.updateLock.mockResolvedValue({ lock: { ...registeredLock, status: "offline" } });
    const revokeImei = vi.fn();
    setLockGateway({ revokeImei } as any);

    const res = await lockRequest("/api/admin/locks/7", "PATCH", { status: "offline" });

    expect(res.status).toBe(200);
    expect(revokeImei).not.toHaveBeenCalled();
  });

  it("does not crash decommissioning a lock when the OMNI gateway is offline", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
    storageMock.decommissionLock.mockResolvedValue({
      lock: { ...registeredLock, status: "decommissioned" },
    });
    setLockGateway(null); // gateway process not running — must be best-effort.

    const res = await lockRequest("/api/admin/locks/7", "DELETE");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("decommissioned");
  });
});

describe("POST /api/admin/bikes/:id/purge", () => {
  const operator = { id: "operator-2", role: "operator" };
  const admin = { id: "admin-1", role: "admin" };

  it("rejects an operator — only admin may permanently purge a bike", async () => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);

    const res = await lockRequest("/api/admin/bikes/bike-1/purge", "POST");

    expect(res.status).toBe(403);
    expect(storageMock.purgeArchivedTestBike).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const res = await lockRequest("/api/admin/bikes/bike-1/purge", "POST");

    expect(res.status).toBe(401);
    expect(storageMock.purgeArchivedTestBike).not.toHaveBeenCalled();
  });

  it("lets an admin purge an archived test bike and returns the deleted counts", async () => {
    sessionUserId = admin.id;
    storageMock.getUser.mockResolvedValue(admin);
    storageMock.purgeArchivedTestBike.mockResolvedValue({
      ok: true,
      deleted: {
        rides: 2, tickets: 0, paymentOrders: 0, reservations: 0, alerts: 0,
        ticketComments: 0, rideFeedback: 2, ridePoints: 30, telemetry: 100,
      },
    });

    const res = await lockRequest("/api/admin/bikes/bike-1/purge", "POST");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      deleted: {
        rides: 2, tickets: 0, paymentOrders: 0, reservations: 0, alerts: 0,
        ticketComments: 0, rideFeedback: 2, ridePoints: 30, telemetry: 100,
      },
    });
    expect(storageMock.purgeArchivedTestBike).toHaveBeenCalledWith("bike-1");
  });

  it("maps a guard rejection (not a test bike) to 400", async () => {
    sessionUserId = admin.id;
    storageMock.getUser.mockResolvedValue(admin);
    storageMock.purgeArchivedTestBike.mockResolvedValue({
      error: "Безвозвратно удалить можно только велосипед с флагом «тестовый» или демо-сидированный",
    });

    const res = await lockRequest("/api/admin/bikes/bike-1/purge", "POST");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Безвозвратно удалить можно только велосипед с флагом «тестовый» или демо-сидированный",
    });
  });

  it("404s when the bike does not exist", async () => {
    sessionUserId = admin.id;
    storageMock.getUser.mockResolvedValue(admin);
    storageMock.purgeArchivedTestBike.mockResolvedValue({ error: "Велосипед не найден" });

    const res = await lockRequest("/api/admin/bikes/ghost/purge", "POST");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Велосипед не найден" });
  });
});

describe("POST /api/admin/bikes/:id/restore", () => {
  const operator = { id: "operator-4", role: "operator" };
  const restoredBike = {
    id: "bike-1", model: "Cruiser", battery: 80, lat: 100, lng: 100,
    lastSeen: 0, idleHours: 0, flagged: false, parkingId: null,
    lockImei: "862596083776074", lockOnline: true, lockLastSeen: 0,
    notes: null, maintenanceReason: null, seed: false, status: "offline",
  };

  beforeEach(() => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
  });

  it("requires a session", async () => {
    sessionUserId = null;

    const res = await lockRequest("/api/admin/bikes/bike-1/restore", "POST");

    expect(res.status).toBe(401);
    expect(storageMock.restoreBike).not.toHaveBeenCalled();
  });

  it("restores an archived bike to offline and syncs the GPS interval", async () => {
    storageMock.restoreBike.mockResolvedValue({ bike: restoredBike });
    const syncGpsTrackingForStatus = vi.fn();
    setLockGateway({ sendUnlockCommand: vi.fn(), syncGpsTrackingForStatus } as any);

    const res = await lockRequest("/api/admin/bikes/bike-1/restore", "POST");
    await new Promise((r) => setTimeout(r, 0));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(restoredBike);
    expect(storageMock.restoreBike).toHaveBeenCalledWith("bike-1");
    expect(syncGpsTrackingForStatus).toHaveBeenCalledWith(restoredBike.lockImei, restoredBike.id, "offline");
  });

  it("maps \"not archived\" guard rejection to 400", async () => {
    storageMock.restoreBike.mockResolvedValue({ error: "Велосипед не в архиве" });

    const res = await lockRequest("/api/admin/bikes/bike-1/restore", "POST");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Велосипед не в архиве" });
  });

  it("404s when the bike does not exist", async () => {
    storageMock.restoreBike.mockResolvedValue({ error: "Велосипед не найден" });

    const res = await lockRequest("/api/admin/bikes/ghost/restore", "POST");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Велосипед не найден" });
  });

  it("skips the GPS sync when the bike has no fitted lock", async () => {
    storageMock.restoreBike.mockResolvedValue({ bike: { ...restoredBike, lockImei: null } });
    const syncGpsTrackingForStatus = vi.fn();
    setLockGateway({ sendUnlockCommand: vi.fn(), syncGpsTrackingForStatus } as any);

    const res = await lockRequest("/api/admin/bikes/bike-1/restore", "POST");

    expect(res.status).toBe(200);
    expect(syncGpsTrackingForStatus).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/bikes/:id \u2014 movement-alarm suppression on status change", () => {
  const operator = { id: "operator-3", role: "operator" };
  const bike = {
    id: "BC-100", model: "Cruiser", battery: 80, lat: 100, lng: 100,
    lastSeen: 0, idleHours: 0, flagged: false, parkingId: null,
    lockImei: "862596083776074", lockOnline: true, lockLastSeen: 0,
    notes: null, maintenanceReason: null, seed: false,
  };

  beforeEach(() => {
    sessionUserId = operator.id;
    storageMock.getUser.mockResolvedValue(operator);
  });

  it.each(["maintenance", "archived"])(
    "unlocks the lock (opaque userId 0) when status changes to %s, with no active ride",
    async (status) => {
      storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, status } });
      storageMock.getActiveRideForBike.mockResolvedValue(undefined);
      const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
      setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus: vi.fn() } as any);

      const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status });
      await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget promise settle

      expect(res.status).toBe(200);
      expect(sendUnlockCommand).toHaveBeenCalledWith(bike.lockImei, 0);
    },
  );

  it.each(["storage"])(
    "does NOT unlock the lock when status changes to %s (bike-status lifecycle fix, 2026-09) " +
      "\u2014 a bike parked/asleep must stay physically locked",
    async (status) => {
      storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, status } });
      storageMock.getActiveRideForBike.mockResolvedValue(undefined);
      const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
      setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus: vi.fn() } as any);

      const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status });
      await new Promise((r) => setTimeout(r, 0));

      expect(res.status).toBe(200);
      expect(sendUnlockCommand).not.toHaveBeenCalled();
    },
  );

  it(
    "does not unlock for \"offline\" (rental spec addendum, 2026-09) \u2014 a bike must never " +
      "be reachable/openable once it drops out of rotation on a dead lock battery",
    async () => {
      storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, status: "offline" } });
      storageMock.getActiveRideForBike.mockResolvedValue(undefined);
      const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
      setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus: vi.fn() } as any);

      const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status: "offline" });
      await new Promise((r) => setTimeout(r, 0));

      expect(res.status).toBe(200);
      expect(sendUnlockCommand).not.toHaveBeenCalled();
    },
  );

  it("does not unlock for an in-rotation status (available)", async () => {
    storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, status: "available" } });
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus: vi.fn() } as any);

    const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status: "available" });

    expect(res.status).toBe(200);
    expect(sendUnlockCommand).not.toHaveBeenCalled();
  });

  it.each(["available", "maintenance", "offline", "storage", "archived", "lost"] as const)(
    "syncs the D1 GPS-tracking interval to the new status (%s) on every status-change PATCH",
    async (status) => {
      storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, status } });
      storageMock.getActiveRideForBike.mockResolvedValue(undefined);
      const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
      const syncGpsTrackingForStatus = vi.fn();
      setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus } as any);

      const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status });
      await new Promise((r) => setTimeout(r, 0));

      expect(res.status).toBe(200);
      expect(syncGpsTrackingForStatus).toHaveBeenCalledWith(bike.lockImei, bike.id, status);
    },
  );

  it("does not unlock for \"lost\" \u2014 alarming on movement is the desired behavior there", async () => {
    storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, status: "lost" } });
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus: vi.fn() } as any);

    const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status: "lost" });

    expect(res.status).toBe(200);
    expect(sendUnlockCommand).not.toHaveBeenCalled();
  });

  it("refuses to unlock when the bike has an active ride (safety)", async () => {
    storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, status: "maintenance" } });
    storageMock.getActiveRideForBike.mockResolvedValue({ id: 9, bikeId: bike.id, userId: "rider-1", status: "active" });
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus: vi.fn() } as any);

    const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status: "maintenance" });
    await new Promise((r) => setTimeout(r, 0));

    expect(res.status).toBe(200);
    expect(sendUnlockCommand).not.toHaveBeenCalled();
  });

  it("does not fail the request when the lock is offline / unlock rejects", async () => {
    storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, status: "archived" } });
    storageMock.getActiveRideForBike.mockResolvedValue(undefined);
    const sendUnlockCommand = vi.fn().mockRejectedValue(new Error("lock is not connected"));
    setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus: vi.fn() } as any);

    const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status: "archived" });
    await new Promise((r) => setTimeout(r, 0));

    expect(res.status).toBe(200);
    expect(sendUnlockCommand).toHaveBeenCalledWith(bike.lockImei, 0);
  });

  it("skips entirely when the bike has no fitted lock", async () => {
    storageMock.adminUpdateBike.mockResolvedValue({ bike: { ...bike, lockImei: null, status: "archived" } });
    const sendUnlockCommand = vi.fn().mockResolvedValue({ success: true });
    setLockGateway({ sendUnlockCommand, syncGpsTrackingForStatus: vi.fn() } as any);

    const res = await lockRequest(`/api/admin/bikes/${bike.id}`, "PATCH", { status: "archived" });

    expect(res.status).toBe(200);
    expect(sendUnlockCommand).not.toHaveBeenCalled();
    expect(storageMock.getActiveRideForBike).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/alerts", () => {
  it("requires a session", async () => {
    const res = await lockRequest("/api/admin/alerts");

    expect(res.status).toBe(401);
    expect(storageMock.listAlerts).not.toHaveBeenCalled();
  });

  it("refuses a signed-in rider", async () => {
    sessionUserId = "u-rider";
    storageMock.getUser.mockResolvedValue({ id: "u-rider", role: "rider" });

    const res = await lockRequest("/api/admin/alerts");

    expect(res.status).toBe(403);
    expect(storageMock.listAlerts).not.toHaveBeenCalled();
  });

  it("allows a mechanic (read-only) and returns the open fall alerts", async () => {
    sessionUserId = "u-mech";
    storageMock.getUser.mockResolvedValue({ id: "u-mech", role: "mechanic" });
    storageMock.listAlerts.mockResolvedValue([
      { id: 1, bikeId: "BC-01", kind: "fall", severity: "critical", message: "Упал", createdAt: 1000, acknowledgedAt: null, acknowledgedBy: null },
    ]);

    const res = await lockRequest("/api/admin/alerts");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, bikeId: "BC-01", kind: "fall", severity: "critical", message: "Упал", createdAt: 1000, acknowledgedAt: null, acknowledgedBy: null },
    ]);
  });
});

describe("POST /api/admin/alerts/:id/ack", () => {
  it("requires a session", async () => {
    const res = await lockRequest("/api/admin/alerts/1/ack", "POST", {});

    expect(res.status).toBe(401);
    expect(storageMock.acknowledgeAlert).not.toHaveBeenCalled();
  });

  it("refuses a mechanic (read-only role — ack requires operator/admin)", async () => {
    sessionUserId = "u-mech2";
    storageMock.getUser.mockResolvedValue({ id: "u-mech2", role: "mechanic" });

    const res = await lockRequest("/api/admin/alerts/1/ack", "POST", {});

    expect(res.status).toBe(403);
    expect(storageMock.acknowledgeAlert).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric id without touching storage", async () => {
    sessionUserId = "u-op";
    storageMock.getUser.mockResolvedValue({ id: "u-op", role: "operator" });

    const res = await lockRequest("/api/admin/alerts/not-a-number/ack", "POST", {});

    expect(res.status).toBe(404);
    expect(storageMock.acknowledgeAlert).not.toHaveBeenCalled();
  });

  it("acknowledges as the resolved actor name and returns the updated row", async () => {
    sessionUserId = "u-op2";
    storageMock.getUser.mockResolvedValue({ id: "u-op2", role: "operator", name: "Иван" });
    storageMock.acknowledgeAlert.mockResolvedValue({
      id: 1, bikeId: "BC-01", kind: "fall", severity: "critical", message: "Упал",
      createdAt: 1000, acknowledgedAt: 2000, acknowledgedBy: "Иван",
    });

    const res = await lockRequest("/api/admin/alerts/1/ack", "POST", {});

    expect(res.status).toBe(200);
    expect(storageMock.acknowledgeAlert).toHaveBeenCalledWith(1, "Иван");
    expect(res.body).toMatchObject({ acknowledgedBy: "Иван", acknowledgedAt: 2000 });
  });

  it("returns 404 when the alert is missing or already acknowledged", async () => {
    sessionUserId = "u-op3";
    storageMock.getUser.mockResolvedValue({ id: "u-op3", role: "admin", name: "Админ" });
    storageMock.acknowledgeAlert.mockResolvedValue(undefined);

    const res = await lockRequest("/api/admin/alerts/999/ack", "POST", {});

    expect(res.status).toBe(404);
  });
});

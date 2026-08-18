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
  listLocks: vi.fn(),
  createLock: vi.fn(),
  getLock: vi.fn(),
  updateLock: vi.fn(),
  decommissionLock: vi.fn(),
  getActiveRideForBike: vi.fn(),
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

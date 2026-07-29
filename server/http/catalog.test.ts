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
  listUnassignedLocks: vi.fn(),
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

// The session is normally installed by express-session; the guard only ever
// reads req.session.userId, so a test sets it directly via a header.
let sessionUserId: string | null = null;

const app = express();
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
  sessionUserId = null;
});

async function getLocks(): Promise<{ status: number; body: any }> {
  if (!server) await start();
  const res = await fetch(`${baseUrl}/api/admin/locks/unassigned`);
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

  it("asks the storage layer only for locks seen within the last day", async () => {
    sessionUserId = "u3";
    storageMock.getUser.mockResolvedValue({ id: "u3", role: "admin" });
    storageMock.listUnassignedLocks.mockResolvedValue([]);

    const day = 24 * 60 * 60 * 1000;
    const before = Date.now();
    await getLocks();
    const after = Date.now();

    const [cutoff] = storageMock.listUnassignedLocks.mock.calls[0];
    expect(cutoff).toBeGreaterThanOrEqual(before - day);
    expect(cutoff).toBeLessThanOrEqual(after - day);
  });
});

// Tests for GET /api/bikes's rider-facing visibility filter
// (filterBikesForRider, server/http/catalog.ts) — specifically the 2026-09
// combined reservation+ride budget feature, where a rider may hold up to
// MAX_ACTIVE_RIDES_PER_USER (2) active reservations at once and must see
// every one of "their own" reserved bikes, not just a single one.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const storageMock = vi.hoisted(() => ({
  getUser: vi.fn(),
  listBikes: vi.fn(),
  getActiveRides: vi.fn(),
  getActiveReservations: vi.fn(),
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
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionUserId = null;
  storageMock.getUser.mockResolvedValue(undefined); // never staff by default
});

async function getBikes(): Promise<{ status: number; body: any }> {
  if (!server) await start();
  const res = await fetch(`${baseUrl}/api/bikes`);
  return { status: res.status, body: await res.json() };
}

describe("GET /api/bikes — rider visibility with two concurrent reservations", () => {
  it("shows the rider both of their own reserved bikes, but not a bike reserved by someone else", async () => {
    sessionUserId = "rider-1";
    storageMock.listBikes.mockResolvedValue([
      { id: "BC-01", status: "reserved" },
      { id: "BC-02", status: "reserved" },
      { id: "BC-03", status: "reserved" }, // someone else's
      { id: "BC-04", status: "available" },
    ]);
    storageMock.getActiveRides.mockResolvedValue([]);
    storageMock.getActiveReservations.mockResolvedValue([
      { id: 1, bikeId: "BC-01", userId: "rider-1", status: "active" },
      { id: 2, bikeId: "BC-02", userId: "rider-1", status: "active" },
    ]);

    const res = await getBikes();

    expect(res.status).toBe(200);
    expect(res.body.map((b: any) => b.id).sort()).toEqual(["BC-01", "BC-02", "BC-04"]);
  });

  it("hides all reserved bikes from a rider with no reservations of their own", async () => {
    sessionUserId = "rider-2";
    storageMock.listBikes.mockResolvedValue([
      { id: "BC-01", status: "reserved" },
      { id: "BC-04", status: "available" },
    ]);
    storageMock.getActiveRides.mockResolvedValue([]);
    storageMock.getActiveReservations.mockResolvedValue([]);

    const res = await getBikes();

    expect(res.body.map((b: any) => b.id)).toEqual(["BC-04"]);
  });
});

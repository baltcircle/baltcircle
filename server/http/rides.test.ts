import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audit HIGH #11: server/http/rides.ts (start/pause/resume/extend/end and the
// surrounding read/admin/telemetry routes — 15 routes total) had zero test
// coverage despite being the core rental lifecycle. Storage and push are
// mocked; rideEvents is a REAL EventEmitter so the SSE stream test exercises
// actual subscribe/publish/unsubscribe behaviour, not a mock recording calls.

const storageMock = vi.hoisted(() => ({
  getUser: vi.fn(),
  listRides: vi.fn(),
  getActiveRides: vi.fn(),
  startRide: vi.fn(),
  appendRidePoint: vi.fn(),
  getRide: vi.fn(),
  requestPauseRide: vi.fn(),
  resumeRide: vi.fn(),
  extendRide: vi.fn(),
  requestEndRide: vi.fn(),
  cancelPendingEnd: vi.fn(),
  submitRideFeedback: vi.fn(),
  getBikeTelemetry: vi.fn(),
  insertBikeTelemetry: vi.fn(),
  listAdminRides: vi.fn(),
  countRides: vi.fn(),
  listRideFeedback: vi.fn(),
  countRideFeedback: vi.fn(),
  endRide: vi.fn(),
}));
const rideEvents = vi.hoisted(() => {
  // vi.hoisted() runs before this file's own top-level imports are evaluated,
  // so a static `import` binding isn't available here yet; require() is the
  // correct tool for this specific case.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return emitter;
});
const sendToUserAsyncMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());

vi.mock("../storage", () => ({ storage: storageMock, rideEvents }));
vi.mock("../index", () => ({ log: logMock }));
vi.mock("../push", () => ({ sendToUserAsync: sendToUserAsyncMock }));
// Real context helpers (riderId/isStaffSession/canManageRide) are exercised
// as-is against a mocked storage — they're small and their exact IDOR/staff
// semantics are the thing worth asserting, not just that they were called.
vi.mock("./context", async () => {
  const actual = await vi.importActual<typeof import("./context")>("./context");
  return {
    ...actual,
    requireRole: vi.fn(() => vi.fn()),
    feedbackLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});
// Not exercised by these routes at runtime with a real config, but imported —
// keep them inert so registerRideRoutes() doesn't need a real T-Bank/SMS setup.
vi.mock("../sms", () => ({
  sendOtpSms: vi.fn(), getSmsDiagnostics: vi.fn(), smsProvider: vi.fn(), getSigmaSmsSendingStatus: vi.fn(),
}));
vi.mock("../tbank", () => ({}));
vi.mock("../payments/tbank-handlers", () => ({}));

import { registerRideRoutes } from "./rides";

type Handler = (req: any, res: any) => Promise<unknown> | unknown;

function routeApp() {
  const get = new Map<string, Handler>();
  const post = new Map<string, Handler>();
  const register = (target: Map<string, Handler>) => (path: string, ...handlers: Handler[]) => {
    target.set(path, handlers.at(-1)!);
  };
  registerRideRoutes({ get: register(get), post: register(post) } as any);
  return { get, post };
}

function response() {
  const res: any = {
    code: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    written: [] as string[],
    ended: false,
    listeners: {} as Record<string, () => void>,
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    writeHead(code: number, headers: Record<string, string>) { this.code = code; Object.assign(this.headers, headers); },
    write(chunk: string) { this.written.push(chunk); return true; },
    flushHeaders() {},
    on(event: string, cb: () => void) { this.listeners[event] = cb; },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TELEMETRY_INGEST_TOKEN;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/rides", () => {
  it("confines an ordinary rider to their own rides, ignoring session mismatch attempts", async () => {
    const { get } = routeApp();
    storageMock.getUser.mockResolvedValue({ id: "user-1", role: "rider" });
    storageMock.listRides.mockResolvedValue([{ id: 1 }]);
    const res = response();

    await get.get("/api/rides")!({ session: { userId: "user-1" }, query: {} }, res);

    expect(storageMock.listRides).toHaveBeenCalledWith({ userId: "user-1", limit: 100 });
    expect(res.body).toEqual([{ id: 1 }]);
  });

  it("rejects a non-staff rider requesting another user's rides via ?userId (IDOR)", async () => {
    const { get } = routeApp();
    storageMock.getUser.mockResolvedValue({ id: "user-1", role: "rider" });
    const res = response();

    await get.get("/api/rides")!(
      { session: { userId: "user-1" }, query: { userId: "victim" } }, res,
    );

    expect(res.code).toBe(403);
    expect(storageMock.listRides).not.toHaveBeenCalled();
  });

  it("lets staff query another rider's rides by userId", async () => {
    const { get } = routeApp();
    storageMock.getUser.mockResolvedValue({ id: "op-1", role: "operator" });
    storageMock.listRides.mockResolvedValue([{ id: 2 }]);
    const res = response();

    await get.get("/api/rides")!(
      { session: { userId: "op-1" }, query: { userId: "rider-9" } }, res,
    );

    expect(storageMock.listRides).toHaveBeenCalledWith({ userId: "rider-9", limit: 100 });
    expect(res.body).toEqual([{ id: 2 }]);
  });

  it("returns the full unfiltered fleet list to staff, but only own rides to a rider", async () => {
    const { get } = routeApp();
    storageMock.listRides.mockResolvedValue([{ id: 3 }]);

    storageMock.getUser.mockResolvedValue({ id: "op-1", role: "admin" });
    await get.get("/api/rides")!({ session: { userId: "op-1" }, query: {} }, response());
    expect(storageMock.listRides).toHaveBeenLastCalledWith({ limit: 100 });

    storageMock.getUser.mockResolvedValue({ id: "user-2", role: "rider" });
    await get.get("/api/rides")!({ session: { userId: "user-2" }, query: {} }, response());
    expect(storageMock.listRides).toHaveBeenLastCalledWith({ userId: "user-2", limit: 100 });
  });
});

describe("GET /api/rides/active", () => {
  it("returns the caller's active rides, defaulting the anonymous demo rider", async () => {
    const { get } = routeApp();
    storageMock.getActiveRides.mockResolvedValue([{ id: 5, userId: "demo" }]);
    const res = response();

    await get.get("/api/rides/active")!({ session: {} }, res);

    expect(storageMock.getActiveRides).toHaveBeenCalledWith("demo");
    expect(res.body).toEqual([{ id: 5, userId: "demo" }]);
  });

  it("returns an empty array when there is no active ride", async () => {
    const { get } = routeApp();
    storageMock.getActiveRides.mockResolvedValue([]);
    const res = response();

    await get.get("/api/rides/active")!({ session: { userId: "user-1" } }, res);

    expect(res.body).toEqual([]);
  });
});

describe("GET /api/rides/active/stream (SSE)", () => {
  it("writes SSE headers, pushes an initial snapshot, and unsubscribes on close", async () => {
    const { get } = routeApp();
    storageMock.getActiveRides.mockResolvedValue([{ id: 7, userId: "user-1" }]);
    const res = response();
    const req = { session: { userId: "user-1" }, on: vi.fn() };

    await get.get("/api/rides/active/stream")!(req, res);
    // The initial push is fire-and-forget (`void push()`); flush microtasks.
    await Promise.resolve(); await Promise.resolve();

    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(rideEvents.listenerCount("user-1")).toBe(1);
    expect(res.written.some((chunk: string) => chunk.includes('"id":7'))).toBe(true);

    const closeCb = req.on.mock.calls.find((c: any[]) => c[0] === "close")?.[1];
    expect(closeCb).toBeTypeOf("function");
    closeCb();

    expect(rideEvents.listenerCount("user-1")).toBe(0);
  });

  it("pushes a fresh snapshot when the ride bus emits for this user, and stops after close", async () => {
    const { get } = routeApp();
    storageMock.getActiveRides.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([]);
    const res = response();
    const req = { session: { userId: "user-2" }, on: vi.fn() };

    await get.get("/api/rides/active/stream")!(req, res);
    await Promise.resolve(); await Promise.resolve();
    res.written.length = 0;

    rideEvents.emit("user-2");
    await Promise.resolve(); await Promise.resolve();
    expect(res.written.some((chunk: string) => chunk.includes("data:"))).toBe(true);

    const closeCb = req.on.mock.calls.find((c: any[]) => c[0] === "close")?.[1];
    closeCb();
    res.written.length = 0;
    rideEvents.emit("user-2");
    await Promise.resolve();
    expect(res.written.length).toBe(0);
  });
});

describe("POST /api/rides/start", () => {
  it("rejects an invalid body (bad tariff) with 400 before touching storage", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/rides/start")!(
      { body: { bikeId: "bike-1", tariff: "not-a-tariff" }, session: {} }, res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.startRide).not.toHaveBeenCalled();
  });

  it("blocks a blocked account from starting a new rental", async () => {
    const { post } = routeApp();
    storageMock.getUser.mockResolvedValue({ id: "user-1", blockedAt: Date.now() });
    const res = response();

    await post.get("/api/rides/start")!(
      { body: { bikeId: "bike-1", tariff: "h1" }, session: { userId: "user-1" } }, res,
    );

    expect(res.code).toBe(403);
    expect(storageMock.startRide).not.toHaveBeenCalled();
  });

  it("surfaces a storage-layer business error (e.g. bike unavailable) as 400", async () => {
    const { post } = routeApp();
    storageMock.getUser.mockResolvedValue({ id: "user-1", blockedAt: null });
    storageMock.startRide.mockResolvedValue({ error: "Велосипед недоступен" });
    const res = response();

    await post.get("/api/rides/start")!(
      { body: { bikeId: "bike-1", tariff: "h1" }, session: { userId: "user-1" } }, res,
    );

    expect(res.code).toBe(400);
    expect(res.body).toEqual({ error: "Велосипед недоступен" });
  });

  it("starts a ride for a valid unblocked rider", async () => {
    const { post } = routeApp();
    storageMock.getUser.mockResolvedValue({ id: "user-1", blockedAt: null });
    storageMock.startRide.mockResolvedValue({ id: 42, userId: "user-1", bikeId: "bike-1" });
    const res = response();

    await post.get("/api/rides/start")!(
      { body: { bikeId: "bike-1", tariff: "h2" }, session: { userId: "user-1" } }, res,
    );

    expect(storageMock.startRide).toHaveBeenCalledWith({ bikeId: "bike-1", userId: "user-1", tariff: "h2" });
    expect(res.body).toEqual({ id: 42, userId: "user-1", bikeId: "bike-1" });
  });
});

describe("ride-ownership-gated mutation routes (pause/resume/extend/end/cancel-end)", () => {
  const cases: Array<{ path: string; extraBody?: Record<string, unknown>; storageMethod: keyof typeof storageMock; storageArgs: unknown[] }> = [
    { path: "/api/rides/:id/pause", storageMethod: "requestPauseRide", storageArgs: [55] },
    { path: "/api/rides/:id/resume", storageMethod: "resumeRide", storageArgs: [55] },
    { path: "/api/rides/:id/extend", extraBody: { tariff: "h1" }, storageMethod: "extendRide", storageArgs: [55, "h1"] },
    { path: "/api/rides/:id/end", storageMethod: "requestEndRide", storageArgs: [55] },
    { path: "/api/rides/:id/cancel-end", storageMethod: "cancelPendingEnd", storageArgs: [55] },
  ];

  it.each(cases)("$path returns 404 when the ride does not exist", async ({ path }) => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue(undefined);
    const res = response();

    await post.get(path)!(
      { params: { id: "55" }, body: { tariff: "h1" }, session: { userId: "user-1" } }, res,
    );

    expect(res.code).toBe(404);
  });

  it.each(cases)("$path returns 403 for a rider who does not own the ride and isn't staff", async ({ path }) => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 55, userId: "owner" });
    storageMock.getUser.mockResolvedValue({ id: "attacker", role: "rider" });
    const res = response();

    await post.get(path)!(
      { params: { id: "55" }, body: { tariff: "h1" }, session: { userId: "attacker" } }, res,
    );

    expect(res.code).toBe(403);
  });

  it.each(cases)("$path calls the storage mutation and returns its result for the owning rider", async ({ path, extraBody, storageMethod, storageArgs }) => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 55, userId: "user-1" });
    (storageMock[storageMethod] as any).mockResolvedValue({ ok: true, id: 55 });
    const res = response();

    await post.get(path)!(
      { params: { id: "55" }, body: extraBody ?? {}, session: { userId: "user-1" } }, res,
    );

    expect(storageMock[storageMethod]).toHaveBeenCalledWith(...storageArgs);
    expect(res.body).toEqual({ ok: true, id: 55 });
  });

  it.each(cases)("$path surfaces a storage-layer { error } as 400 (except end, which 404s on falsy result)", async ({ path, storageMethod }) => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 55, userId: "user-1" });
    (storageMock[storageMethod] as any).mockResolvedValue({ error: "Невозможно выполнить" });
    const res = response();

    await post.get(path)!(
      { params: { id: "55" }, body: { tariff: "h1" }, session: { userId: "user-1" } }, res,
    );

    expect(res.code).toBe(400);
    expect(res.body).toEqual({ error: "Невозможно выполнить" });
  });

  it("staff (non-owner) may pause/end another rider's ride", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 55, userId: "owner" });
    storageMock.getUser.mockResolvedValue({ id: "op-1", role: "operator" });
    storageMock.requestPauseRide.mockResolvedValue({ status: "paused", ride: { id: 55 } });
    const res = response();

    await post.get("/api/rides/:id/pause")!(
      { params: { id: "55" }, body: {}, session: { userId: "op-1" } }, res,
    );

    expect(res.code).toBe(200);
    expect(res.body).toEqual({ status: "paused", ride: { id: 55 } });
  });
});

describe("POST /api/rides/:id/extend validation", () => {
  it("rejects a missing/invalid tariff with 400 before checking ride ownership", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/rides/:id/extend")!(
      { params: { id: "55" }, body: { tariff: "bogus" }, session: { userId: "user-1" } }, res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.getRide).not.toHaveBeenCalled();
  });
});

describe("POST /api/rides/:id/point", () => {
  it("validates numeric coordinates", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/rides/:id/point")!(
      { params: { id: "1" }, body: { x: "not-a-number", y: 2 }, session: {} }, res,
    );

    expect(res.code).toBe(400);
  });

  it("404s when appendRidePoint finds no active ride to append to", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 1, userId: "demo" });
    storageMock.appendRidePoint.mockResolvedValue(undefined);
    const res = response();

    await post.get("/api/rides/:id/point")!(
      { params: { id: "1" }, body: { x: 1, y: 2 }, session: {} }, res,
    );

    expect(res.code).toBe(404);
  });

  it("appends a point for an owned ride and returns the updated ride", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 1, userId: "demo" });
    storageMock.appendRidePoint.mockResolvedValue({ id: 1, track: "[[1,2]]" });
    const res = response();

    await post.get("/api/rides/:id/point")!(
      { params: { id: "1" }, body: { x: 1, y: 2 }, session: {} }, res,
    );

    expect(storageMock.appendRidePoint).toHaveBeenCalledWith(1, 1, 2);
    expect(res.body).toEqual({ id: 1, track: "[[1,2]]" });
  });
});

describe("POST /api/rides/:id/feedback", () => {
  it("404s for a non-existent ride", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue(undefined);
    const res = response();

    await post.get("/api/rides/:id/feedback")!(
      { params: { id: "1" }, body: { rating: 5 }, session: {} }, res,
    );

    expect(res.code).toBe(404);
  });

  it("403s a caller who doesn't own the ride and isn't staff", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 1, userId: "owner", status: "completed" });
    storageMock.getUser.mockResolvedValue({ id: "attacker", role: "rider" });
    const res = response();

    await post.get("/api/rides/:id/feedback")!(
      { params: { id: "1" }, body: { rating: 5 }, session: { userId: "attacker" } }, res,
    );

    expect(res.code).toBe(403);
  });

  it("409s while the ride is still active", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 1, userId: "demo", status: "active" });
    const res = response();

    await post.get("/api/rides/:id/feedback")!(
      { params: { id: "1" }, body: { rating: 5 }, session: {} }, res,
    );

    expect(res.code).toBe(409);
    expect(storageMock.submitRideFeedback).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range rating with 400", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 1, userId: "demo", status: "completed" });
    const res = response();

    await post.get("/api/rides/:id/feedback")!(
      { params: { id: "1" }, body: { rating: 7 }, session: {} }, res,
    );

    expect(res.code).toBe(400);
  });

  it("attributes feedback to the ride's owner, not the acting staff session", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 1, userId: "rider-owner", status: "completed" });
    storageMock.getUser.mockResolvedValue({ id: "op-1", role: "operator" });
    storageMock.submitRideFeedback.mockResolvedValue({ id: 9, rating: 5 });
    const res = response();

    await post.get("/api/rides/:id/feedback")!(
      { params: { id: "1" }, body: { rating: 5, reasons: [] }, session: { userId: "op-1" } }, res,
    );

    expect(storageMock.submitRideFeedback).toHaveBeenCalledWith(
      1, "rider-owner", expect.objectContaining({ rating: 5 }),
    );
    expect(res.body).toEqual({ id: 9, rating: 5 });
  });
});

describe("GET /api/rides/:id/track", () => {
  it("404s for a non-existent ride", async () => {
    const { get } = routeApp();
    storageMock.getRide.mockResolvedValue(undefined);
    const res = response();

    await get.get("/api/rides/:id/track")!({ params: { id: "1" }, session: {} }, res);

    expect(res.code).toBe(404);
  });

  it("403s a caller without access to the ride", async () => {
    const { get } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 1, userId: "owner", startedAt: 0, endedAt: 1000, track: "[]" });
    storageMock.getUser.mockResolvedValue({ id: "attacker", role: "rider" });
    const res = response();

    await get.get("/api/rides/:id/track")!({ params: { id: "1" }, session: { userId: "attacker" } }, res);

    expect(res.code).toBe(403);
  });

  it("prefers the bike's onboard tracker over the phone track when it has enough points", async () => {
    const { get } = routeApp();
    storageMock.getRide.mockResolvedValue({
      id: 1, userId: "demo", bikeId: "bike-1", startedAt: 0, endedAt: 1000,
      track: JSON.stringify([[1, 1, 500]]),
    });
    storageMock.getBikeTelemetry.mockResolvedValue([[2, 2, 600], [3, 3, 700]]);
    const res = response();

    await get.get("/api/rides/:id/track")!({ params: { id: "1" }, session: {} }, res);

    expect(storageMock.getBikeTelemetry).toHaveBeenCalledWith("bike-1", 0, 1000);
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ source: "tracker" });
  });

  it("falls back to the phone track when the tracker has fewer than 2 points", async () => {
    const { get } = routeApp();
    storageMock.getRide.mockResolvedValue({
      id: 1, userId: "demo", bikeId: "bike-1", startedAt: 0, endedAt: 1000,
      track: JSON.stringify([[1, 1, 500], [2, 2, 600]]),
    });
    storageMock.getBikeTelemetry.mockResolvedValue([]);
    const res = response();

    await get.get("/api/rides/:id/track")!({ params: { id: "1" }, session: {} }, res);

    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ source: "phone" });
  });

  it("treats a corrupt phone track as empty instead of throwing", async () => {
    const { get } = routeApp();
    storageMock.getRide.mockResolvedValue({
      id: 1, userId: "demo", bikeId: "bike-1", startedAt: 0, endedAt: 1000, track: "not-json",
    });
    storageMock.getBikeTelemetry.mockResolvedValue([]);
    const res = response();

    await get.get("/api/rides/:id/track")!({ params: { id: "1" }, session: {} }, res);

    expect(res.code).toBe(200);
  });
});

describe("POST /api/telemetry/bike", () => {
  it("returns 503 when no ingest token is configured", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/telemetry/bike")!(
      { get: () => undefined, body: { bikeId: "b1", lat: 54.7, lng: 20.5 } }, res,
    );

    expect(res.code).toBe(503);
  });

  it("rejects a missing/incorrect bearer token with 401", async () => {
    process.env.TELEMETRY_INGEST_TOKEN = "secret-token";
    const { post } = routeApp();
    const res = response();

    await post.get("/api/telemetry/bike")!(
      { get: () => "Bearer wrong-token", body: { bikeId: "b1", lat: 54.7, lng: 20.5 } }, res,
    );

    expect(res.code).toBe(401);
    expect(storageMock.insertBikeTelemetry).not.toHaveBeenCalled();
  });

  it("rejects a malformed body with 400 even when the token is valid", async () => {
    process.env.TELEMETRY_INGEST_TOKEN = "secret-token";
    const { post } = routeApp();
    const res = response();

    await post.get("/api/telemetry/bike")!(
      { get: () => "Bearer secret-token", body: { bikeId: "b1", lat: "nan", lng: 20.5 } }, res,
    );

    expect(res.code).toBe(400);
  });

  it("ingests a valid authenticated telemetry point", async () => {
    process.env.TELEMETRY_INGEST_TOKEN = "secret-token";
    const { post } = routeApp();
    const res = response();

    await post.get("/api/telemetry/bike")!(
      { get: () => "Bearer secret-token", body: { bikeId: "b1", lat: 54.7, lng: 20.5, ts: 12345 } }, res,
    );

    expect(storageMock.insertBikeTelemetry).toHaveBeenCalledWith("b1", expect.any(Number), expect.any(Number), 12345);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("GET /api/admin/rides", () => {
  it("sets X-Total-Count and returns the paginated admin ride list", async () => {
    const { get } = routeApp();
    storageMock.countRides.mockResolvedValue(123);
    storageMock.listAdminRides.mockResolvedValue([{ id: 1 }]);
    const res = response();

    await get.get("/api/admin/rides")!({ query: { limit: "10", offset: "0" } }, res);

    expect(res.headers["X-Total-Count"]).toBe("123");
    expect(storageMock.listAdminRides).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    expect(res.body).toEqual([{ id: 1 }]);
  });
});

describe("GET /api/admin/feedback", () => {
  it("sets X-Total-Count and returns the paginated admin feedback list", async () => {
    const { get } = routeApp();
    storageMock.countRideFeedback.mockResolvedValue(42);
    storageMock.listRideFeedback.mockResolvedValue([{ id: 1, rating: 5 }]);
    const res = response();

    await get.get("/api/admin/feedback")!({ query: { limit: "10", offset: "0" } }, res);

    expect(res.headers["X-Total-Count"]).toBe("42");
    expect(storageMock.listRideFeedback).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    expect(res.body).toEqual([{ id: 1, rating: 5 }]);
  });
});

describe("POST /api/admin/rides/:id/end", () => {
  it("404s when the ride isn't active", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue(undefined);
    storageMock.endRide.mockResolvedValue(undefined);
    const res = response();

    await post.get("/api/admin/rides/:id/end")!({ params: { id: "9" } }, res);

    expect(res.code).toBe(404);
  });

  it("force-ends bypassing the geofence and notifies the rider", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 9, userId: "rider-1" });
    storageMock.endRide.mockResolvedValue({ id: 9, status: "completed" });
    const res = response();

    await post.get("/api/admin/rides/:id/end")!({ params: { id: "9" } }, res);

    expect(storageMock.endRide).toHaveBeenCalledWith(9, { skipGeofence: true });
    expect(sendToUserAsyncMock).toHaveBeenCalledWith("rider-1", expect.objectContaining({
      tag: "ride:9",
    }));
    expect(res.body).toEqual({ id: 9, status: "completed" });
  });

  it("surfaces a storage-layer error as 400 without notifying the rider", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue({ id: 9, userId: "rider-1" });
    storageMock.endRide.mockResolvedValue({ error: "Уже завершена" });
    const res = response();

    await post.get("/api/admin/rides/:id/end")!({ params: { id: "9" } }, res);

    expect(res.code).toBe(400);
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });

  it("does not notify when the ride had no owner on record", async () => {
    const { post } = routeApp();
    storageMock.getRide.mockResolvedValue(undefined);
    storageMock.endRide.mockResolvedValue({ id: 9, status: "completed" });
    const res = response();

    await post.get("/api/admin/rides/:id/end")!({ params: { id: "9" } }, res);

    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
    expect(res.body).toEqual({ id: 9, status: "completed" });
  });
});

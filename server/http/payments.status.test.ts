import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit LOW: GET /api/payments/tbank/ride/:orderId and .../wallet/:orderId
// must not leak T-Bank's internal/integration error codes to the client for
// a failed order. `../payments/tbank-handlers` is intentionally left
// UNMOCKED so the real tbankErrorBody allowlist runs end-to-end through the
// route handlers under test.

const storageMock = vi.hoisted(() => ({
  getRidePaymentOrder: vi.fn(),
  getWalletTopupOrder: vi.fn(),
}));

const logMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../index", () => ({ log: logMock }));
vi.mock("../logger", () => ({ logger: loggerMock, log: logMock }));
vi.mock("../context", () => ({
  riderId: vi.fn(),
  isStaffSession: vi.fn(),
  canManageRide: vi.fn(),
  actorName: vi.fn(),
  clientIp: vi.fn(),
  requireRole: vi.fn(() => vi.fn()),
  requireAuth: vi.fn(),
  requireRoleWhenConfigured: vi.fn(),
  otpLimiter: vi.fn(),
  paymentLimiter: vi.fn(),
}));
vi.mock("../tbank", async () => {
  const actual = await vi.importActual<typeof import("../tbank")>("../tbank");
  return { ...actual, getTbankConfig: vi.fn() };
});
// tbank-handlers.ts (left unmocked so its real tbankErrorBody runs) pulls in
// ../push for ride-outcome notifications, AND (since the ride_overage webhook
// branch was added) now also imports ../db/bootstrap directly for its own
// payments-ledger insert — both need their own mock to avoid a real Postgres
// connection attempt during this unit test.
vi.mock("../push", () => ({ sendToUserAsync: vi.fn() }));
vi.mock("../db/bootstrap", () => ({
  db: { insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })) },
  pool: { query: vi.fn() },
  bootstrapReady: Promise.resolve(),
}));

import { registerPaymentRoutes } from "./payments";

type Handler = (req: any, res: any) => Promise<unknown>;

function routeApp() {
  const post = new Map<string, Handler>();
  const get = new Map<string, Handler>();
  const del = new Map<string, Handler>();
  const register = (target: Map<string, Handler>) => (path: string, ...handlers: any[]) => {
    target.set(path, handlers.at(-1));
  };
  registerPaymentRoutes({
    get: register(get),
    post: register(post),
    delete: register(del),
  } as any);
  return { post, get, del };
}

function response() {
  const res = {
    code: 200,
    body: undefined as unknown,
    status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res;
}

function request(params: Record<string, string>) {
  return {
    session: { userId: "user-1" },
    params,
    body: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/payments/tbank/ride/:orderId — audit LOW error sanitization", () => {
  it("collapses a non-rider-facing T-Bank code to the generic message for a failed order", async () => {
    storageMock.getRidePaymentOrder.mockResolvedValue({
      orderId: "order-1", userId: "user-1", status: "failed",
      bikeId: "bike-1", tariffId: "m10", amountKopecks: 5000, rideId: null,
      lastErrorCode: "204", lastErrorMessage: "Неверный токен. Проверьте пару TerminalKey/SecretKey", lastErrorDetails: null,
    });
    const { get } = routeApp();
    const res = response();
    await get.get("/api/payments/tbank/ride/:orderId")!(request({ orderId: "order-1" }), res);

    expect(res.body).toMatchObject({
      status: "failed",
      error: "Платёжный сервис отклонил операцию. Попробуйте позже или другую карту.",
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it("forwards the acquirer's message for a rider-facing decline code on a failed order", async () => {
    storageMock.getRidePaymentOrder.mockResolvedValue({
      orderId: "order-2", userId: "user-1", status: "failed",
      bikeId: "bike-1", tariffId: "m10", amountKopecks: 5000, rideId: null,
      lastErrorCode: "1051", lastErrorMessage: "Недостаточно средств на карте", lastErrorDetails: null,
    });
    const { get } = routeApp();
    const res = response();
    await get.get("/api/payments/tbank/ride/:orderId")!(request({ orderId: "order-2" }), res);

    expect(res.body).toMatchObject({
      status: "failed",
      error: "Недостаточно средств на карте",
      errorCode: "1051",
    });
  });

  it("passes through our own diagnostic text unfiltered when status is not 'failed'", async () => {
    storageMock.getRidePaymentOrder.mockResolvedValue({
      orderId: "order-3", userId: "user-1", status: "paid",
      bikeId: "bike-1", tariffId: "m10", amountKopecks: 5000, rideId: null,
      lastErrorCode: null, lastErrorMessage: "Велосипед уже занят другим пользователем", lastErrorDetails: null,
    });
    const { get } = routeApp();
    const res = response();
    await get.get("/api/payments/tbank/ride/:orderId")!(request({ orderId: "order-3" }), res);

    expect(res.body).toMatchObject({
      status: "paid",
      error: "Велосипед уже занят другим пользователем",
    });
  });

  it("404s when the order belongs to a different user", async () => {
    storageMock.getRidePaymentOrder.mockResolvedValue({ orderId: "order-4", userId: "someone-else", status: "failed" });
    const { get } = routeApp();
    const res = response();
    await get.get("/api/payments/tbank/ride/:orderId")!(request({ orderId: "order-4" }), res);
    expect(res.code).toBe(404);
  });
});

describe("GET /api/payments/tbank/wallet/:orderId — audit LOW error sanitization", () => {
  it("collapses a non-rider-facing T-Bank code to the generic message for a failed order", async () => {
    storageMock.getWalletTopupOrder.mockResolvedValue({
      orderId: "wtopup-1", userId: "user-1", status: "failed", amountKopecks: 10000,
      lastErrorCode: "9999", lastErrorMessage: "Внутренняя ошибка системы", lastErrorDetails: null,
    });
    const { get } = routeApp();
    const res = response();
    await get.get("/api/payments/tbank/wallet/:orderId")!(request({ orderId: "wtopup-1" }), res);

    expect(res.body).toMatchObject({
      status: "failed",
      error: "Платёжный сервис отклонил операцию. Попробуйте позже или другую карту.",
      errorCode: undefined,
    });
  });

  it("forwards the acquirer's message for a rider-facing decline code", async () => {
    storageMock.getWalletTopupOrder.mockResolvedValue({
      orderId: "wtopup-2", userId: "user-1", status: "failed", amountKopecks: 10000,
      lastErrorCode: "1091", lastErrorMessage: "Превышен лимит операций по карте", lastErrorDetails: null,
    });
    const { get } = routeApp();
    const res = response();
    await get.get("/api/payments/tbank/wallet/:orderId")!(request({ orderId: "wtopup-2" }), res);

    expect(res.body).toMatchObject({
      status: "failed",
      error: "Превышен лимит операций по карте",
      errorCode: "1091",
    });
  });
});

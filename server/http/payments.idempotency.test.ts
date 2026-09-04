import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused coverage for audit HIGH #2: the Idempotency-Key guard on
// /api/payments/tbank/ride/init and /api/payments/tbank/ride/charge-saved-card.
// Everything (storage + T-Bank acquirer calls) is mocked so these assert pure
// routing/replay logic, not real payment behavior.

const storageMock = vi.hoisted(() => ({
  getUser: vi.fn(),
  getBike: vi.fn(),
  getActiveRides: vi.fn(),
  getActiveSavedCard: vi.fn(),
  createRidePaymentOrder: vi.fn(),
  reserveRidePaymentOrder: vi.fn(),
  getRidePaymentOrderByIdempotencyKey: vi.fn(),
  updateRidePaymentOrder: vi.fn(),
}));

const tbankMock = vi.hoisted(() => ({
  getTbankConfig: vi.fn(),
  tbankInitRidePayment: vi.fn(),
  tbankInitSavedCardCharge: vi.fn(),
  tbankCharge: vi.fn(),
}));

const startRideForPaidOrderMock = vi.hoisted(() => vi.fn());
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
  return {
    ...actual,
    getTbankConfig: tbankMock.getTbankConfig,
    tbankInitRidePayment: tbankMock.tbankInitRidePayment,
    tbankInitSavedCardCharge: tbankMock.tbankInitSavedCardCharge,
    tbankCharge: tbankMock.tbankCharge,
  };
});
vi.mock("../payments/tbank-handlers", () => ({
  startRideForPaidOrder: startRideForPaidOrderMock,
  tbankErrorBody: (body: { ErrorCode?: unknown; Message?: unknown; Details?: unknown }) => ({
    error: (body.Message as string) || (body.Details as string) || "Ошибка оплаты",
    code: body.ErrorCode,
    message: body.Message,
    details: body.Details,
  }),
  handleTbankNotification: vi.fn(),
  bindingErrorPatch: (body: { ErrorCode?: unknown; Message?: unknown; Details?: unknown }) => ({
    lastErrorCode: (body.ErrorCode as string) ?? null,
    lastErrorMessage: (body.Message as string) ?? null,
    lastErrorDetails: (body.Details as string) ?? null,
  }),
  terminalBindingFailurePatch: vi.fn(() => ({})),
  refundVerificationCharge: vi.fn(),
  bindViaVerificationPayment: vi.fn(),
  maskPan: (pan: string) => pan,
  cardBrand: () => null,
  extractLast4FromLabel: () => null,
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

function request(opts: { session?: unknown; body?: unknown; headers?: Record<string, string> }) {
  const headers = opts.headers ?? {};
  return {
    session: opts.session ?? { userId: "user-1" },
    body: opts.body ?? {},
    get(name: string) { return headers[name] ?? headers[name.toLowerCase()]; },
    headers,
    ip: "203.0.113.10",
    socket: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getUser.mockResolvedValue({ id: "user-1", role: "rider", email: "rider@example.com", phone: "+79991234567" });
  storageMock.getBike.mockResolvedValue({ id: "bike-1", status: "available" });
  storageMock.getActiveRides.mockResolvedValue([]);
  tbankMock.getTbankConfig.mockReturnValue({ publicAppUrl: "https://app.example.test" });
});

describe("POST /api/payments/tbank/ride/init — idempotency (audit HIGH #2)", () => {
  it("rejects a request with no Idempotency-Key header", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/payments/tbank/ride/init")!(
      request({ body: { bikeId: "bike-1", tariffId: "h1" } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(tbankMock.tbankInitRidePayment).not.toHaveBeenCalled();
  });

  it("creates a fresh order and calls T-Bank Init on the first request with a key", async () => {
    storageMock.getRidePaymentOrderByIdempotencyKey.mockResolvedValue(undefined);
    tbankMock.tbankInitRidePayment.mockResolvedValue({ Success: true, PaymentId: 555, PaymentURL: "https://pay.example.test/1" });
    storageMock.createRidePaymentOrder.mockImplementation(async (input: any) => ({
      id: 1, orderId: input.orderId, paymentUrl: null, amountKopecks: input.amountKopecks, status: "pending",
    }));
    storageMock.updateRidePaymentOrder.mockResolvedValue(undefined);
    const { post } = routeApp();
    const res = response();

    await post.get("/api/payments/tbank/ride/init")!(
      request({ body: { bikeId: "bike-1", tariffId: "h1" }, headers: { "Idempotency-Key": "key-abc" } }),
      res,
    );

    expect(tbankMock.tbankInitRidePayment).toHaveBeenCalledTimes(1);
    expect(storageMock.createRidePaymentOrder).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "key-abc" }),
    );
    expect(res.body).toMatchObject({ paymentUrl: "https://pay.example.test/1", status: "pending" });
  });

  it("replays the existing order on a retry with the SAME key without calling T-Bank again", async () => {
    storageMock.getRidePaymentOrderByIdempotencyKey.mockResolvedValue({
      orderId: "ride-9", paymentUrl: "https://pay.example.test/9", amountKopecks: 35000, status: "pending",
    });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/payments/tbank/ride/init")!(
      request({ body: { bikeId: "bike-1", tariffId: "h1" }, headers: { "Idempotency-Key": "key-retry" } }),
      res,
    );

    expect(tbankMock.tbankInitRidePayment).not.toHaveBeenCalled();
    expect(storageMock.createRidePaymentOrder).not.toHaveBeenCalled();
    expect(res.body).toEqual({ orderId: "ride-9", paymentUrl: "https://pay.example.test/9", amountKopecks: 35000, status: "pending" });
  });
});

describe("POST /api/payments/tbank/ride/charge-saved-card — idempotency (audit HIGH #2)", () => {
  beforeEach(() => {
    storageMock.getActiveSavedCard.mockResolvedValue({ id: 7, rebillId: "rebill-1", customerKey: "user-1" });
  });

  it("rejects a request with no Idempotency-Key header", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/payments/tbank/ride/charge-saved-card")!(
      request({ body: { bikeId: "bike-1", tariffId: "h1" } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(tbankMock.tbankInitSavedCardCharge).not.toHaveBeenCalled();
  });

  it("replays a PAID result on retry without charging the card a second time", async () => {
    storageMock.getRidePaymentOrderByIdempotencyKey.mockResolvedValue({
      orderId: "ride-paid-1", status: "paid", rideId: 42, amountKopecks: 35000,
    });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/payments/tbank/ride/charge-saved-card")!(
      request({ body: { bikeId: "bike-1", tariffId: "h1" }, headers: { "Idempotency-Key": "key-paid" } }),
      res,
    );

    expect(tbankMock.tbankInitSavedCardCharge).not.toHaveBeenCalled();
    expect(tbankMock.tbankCharge).not.toHaveBeenCalled();
    expect(res.body).toEqual({ orderId: "ride-paid-1", status: "paid", rideId: 42, amountKopecks: 35000 });
  });

  it("replays a FAILED result on retry without re-attempting the charge", async () => {
    storageMock.getRidePaymentOrderByIdempotencyKey.mockResolvedValue({
      orderId: "ride-failed-1", status: "failed", amountKopecks: 35000,
      lastErrorCode: "DECLINED", lastErrorMessage: "Карта отклонена", lastErrorDetails: null,
    });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/payments/tbank/ride/charge-saved-card")!(
      request({ body: { bikeId: "bike-1", tariffId: "h1" }, headers: { "Idempotency-Key": "key-failed" } }),
      res,
    );

    expect(tbankMock.tbankInitSavedCardCharge).not.toHaveBeenCalled();
    expect(res.code).toBe(402);
    expect(res.body).toMatchObject({ code: "DECLINED", message: "Карта отклонена" });
  });

  it("charges once on a fresh key and starts the ride on a synchronous CONFIRMED", async () => {
    storageMock.getRidePaymentOrderByIdempotencyKey.mockResolvedValue(undefined);
    storageMock.reserveRidePaymentOrder.mockResolvedValue({
      created: true,
      order: { id: 3, orderId: "ride-new-1", status: "pending", amountKopecks: 35000 },
    });
    storageMock.updateRidePaymentOrder.mockResolvedValue(undefined);
    tbankMock.tbankInitSavedCardCharge.mockResolvedValue({ Success: true, PaymentId: 777 });
    tbankMock.tbankCharge.mockResolvedValue({ Success: true, Status: "CONFIRMED" });
    startRideForPaidOrderMock.mockResolvedValue({ ok: true, rideId: 100 });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/payments/tbank/ride/charge-saved-card")!(
      request({ body: { bikeId: "bike-1", tariffId: "h1" }, headers: { "Idempotency-Key": "key-new" } }),
      res,
    );

    expect(tbankMock.tbankCharge).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "paid", rideId: 100 });
  });

  it("does NOT call the acquirer when reservation lost the race to a concurrent duplicate", async () => {
    storageMock.getRidePaymentOrderByIdempotencyKey.mockResolvedValue(undefined);
    storageMock.reserveRidePaymentOrder.mockResolvedValue({
      created: false,
      order: { id: 4, orderId: "ride-race-1", status: "pending", amountKopecks: 35000 },
    });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/payments/tbank/ride/charge-saved-card")!(
      request({ body: { bikeId: "bike-1", tariffId: "h1" }, headers: { "Idempotency-Key": "key-race" } }),
      res,
    );

    expect(tbankMock.tbankInitSavedCardCharge).not.toHaveBeenCalled();
    expect(tbankMock.tbankCharge).not.toHaveBeenCalled();
    expect(res.body).toEqual({ orderId: "ride-race-1", status: "pending", amountKopecks: 35000 });
  });
});

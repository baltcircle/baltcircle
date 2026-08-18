import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused coverage for audit MEDIUM: the Idempotency-Key guard on
// /api/wallet/tariff. Storage is mocked so this asserts pure routing logic
// (header enforcement + error mapping), not real transaction behavior — the
// transaction-level guarantee is covered separately in wallet-concurrency.test.ts.

const storageMock = vi.hoisted(() => ({
  getWallet: vi.fn(),
  purchaseTariff: vi.fn(),
  topUp: vi.fn(),
  listPayments: vi.fn(),
}));

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../index", () => ({ log: vi.fn() }));
vi.mock("../context", () => ({
  riderId: vi.fn((req: any) => req.session.userId),
  isStaffSession: vi.fn(),
  canManageRide: vi.fn(),
  actorName: vi.fn(),
  clientIp: vi.fn(),
  requireRole: vi.fn(() => vi.fn()),
  requireAuth: vi.fn((req: any, res: any, next: any) => next()),
  requireRoleWhenConfigured: vi.fn(),
  otpLimiter: vi.fn(),
  paymentLimiter: vi.fn(),
}));
vi.mock("../sms", () => ({
  sendOtpSms: vi.fn(), getSmsDiagnostics: vi.fn(), smsProvider: vi.fn(), getSigmaSmsSendingStatus: vi.fn(),
}));
vi.mock("../tbank", () => ({
  getTbankConfig: vi.fn(), getTbankDiagnostics: vi.fn(), isTbankConfigured: vi.fn(() => true),
  tbankAddCard: vi.fn(), tbankGetAddCardState: vi.fn(), classifyCardBinding: vi.fn(), classifyInitBinding: vi.fn(),
  verifyNotificationToken: vi.fn(), tbankInitRidePayment: vi.fn(), generateRideOrderId: vi.fn(), classifyRidePayment: vi.fn(),
  tbankInitSavedCardCharge: vi.fn(), tbankCharge: vi.fn(), generateSavedCardRideOrderId: vi.fn(), tbankGetState: vi.fn(),
  tbankAddAccountQr: vi.fn(), tbankGetAddAccountQrState: vi.fn(), generateSbpBindOrderId: vi.fn(),
  extractQrPayload: vi.fn(), classifyAccountBinding: vi.fn(),
}));
vi.mock("../payments/tbank-handlers", () => ({
  startRideForPaidOrder: vi.fn(), tbankErrorBody: vi.fn(), handleTbankNotification: vi.fn(),
  bindingErrorPatch: vi.fn(), refundVerificationCharge: vi.fn(), bindViaVerificationPayment: vi.fn(),
  maskPan: vi.fn(), cardBrand: vi.fn(),
}));

import { registerWalletRoutes } from "./wallet";

type Handler = (req: any, res: any) => Promise<unknown>;

function routeApp() {
  const post = new Map<string, Handler>();
  const get = new Map<string, Handler>();
  const register = (target: Map<string, Handler>) => (path: string, ...handlers: any[]) => {
    target.set(path, handlers.at(-1));
  };
  registerWalletRoutes({ get: register(get), post: register(post) } as any);
  return { post, get };
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

function request(opts: { body?: unknown; headers?: Record<string, string> }) {
  const headers = opts.headers ?? {};
  return {
    session: { userId: "user-1" },
    body: opts.body ?? {},
    get(name: string) { return headers[name] ?? headers[name.toLowerCase()]; },
    headers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/wallet/tariff — idempotency (audit MEDIUM)", () => {
  it("rejects a request with no Idempotency-Key header", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/wallet/tariff")!(request({ body: { tariff: "h1" } }), res);

    expect(res.code).toBe(400);
    expect(storageMock.purchaseTariff).not.toHaveBeenCalled();
  });

  it("passes the Idempotency-Key through to storage.purchaseTariff", async () => {
    storageMock.purchaseTariff.mockResolvedValue({
      wallet: { userId: "user-1", balance: 0, activeTariff: "h1", tariffExpiresAt: 123 },
      payment: { id: 1, userId: "user-1", amount: -19900, kind: "tariff_purchase", description: "x", createdAt: 1 },
    });
    const { post } = routeApp();
    const res = response();

    await post.get("/api/wallet/tariff")!(
      request({ body: { tariff: "h1" }, headers: { "Idempotency-Key": "key-abc" } }),
      res,
    );

    expect(storageMock.purchaseTariff).toHaveBeenCalledWith("user-1", "h1", expect.any(Number), expect.any(Number), "key-abc");
    expect(res.code).toBe(200);
  });

  it("maps the insufficient-funds error from storage to a 400 with the same message", async () => {
    storageMock.purchaseTariff.mockRejectedValue(new Error("Недостаточно средств на балансе"));
    const { post } = routeApp();
    const res = response();

    await post.get("/api/wallet/tariff")!(
      request({ body: { tariff: "h1" }, headers: { "Idempotency-Key": "key-poor" } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(res.body).toEqual({ error: "Недостаточно средств на балансе" });
  });

  it("re-throws unexpected storage errors instead of swallowing them", async () => {
    storageMock.purchaseTariff.mockRejectedValue(new Error("connection terminated"));
    const { post } = routeApp();
    const res = response();

    await expect(
      post.get("/api/wallet/tariff")!(
        request({ body: { tariff: "h1" }, headers: { "Idempotency-Key": "key-err" } }),
        res,
      ),
    ).rejects.toThrow("connection terminated");
  });

  it("rejects an unknown tariff before ever calling storage", async () => {
    const { post } = routeApp();
    const res = response();

    await post.get("/api/wallet/tariff")!(
      request({ body: { tariff: "bogus" }, headers: { "Idempotency-Key": "key-bad-tariff" } }),
      res,
    );

    expect(res.code).toBe(400);
    expect(storageMock.purchaseTariff).not.toHaveBeenCalled();
  });
});

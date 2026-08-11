import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the two polling activation handlers through their registered routes.
// All infrastructure is mocked: this asserts the lifecycle decisions without a
// T-Bank terminal or database.
const storageMock = vi.hoisted(() => ({
  getPaymentMethod: vi.fn(),
  getUser: vi.fn(),
  updatePaymentMethod: vi.fn(),
  findActiveCardDuplicate: vi.fn(),
  getBlockingCard: vi.fn(),
  unlinkPaymentMethod: vi.fn(),
}));
const tbankMock = vi.hoisted(() => ({
  getTbankConfig: vi.fn(),
  tbankGetAddCardState: vi.fn(),
  tbankGetState: vi.fn(),
  tbankRemoveCard: vi.fn(),
}));
const refundVerificationChargeMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../index", () => ({ log: logMock }));
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
    tbankGetAddCardState: tbankMock.tbankGetAddCardState,
    tbankGetState: tbankMock.tbankGetState,
    tbankRemoveCard: tbankMock.tbankRemoveCard,
  };
});
vi.mock("../payments/tbank-handlers", () => ({
  startRideForPaidOrder: vi.fn(),
  tbankErrorBody: vi.fn(),
  handleTbankNotification: vi.fn(),
  bindingErrorPatch: vi.fn(() => ({})),
  refundVerificationCharge: refundVerificationChargeMock,
  bindViaVerificationPayment: vi.fn(),
  maskPan: (pan: string) => `•••• ${pan.replace(/\D/g, "").slice(-4)}`,
  cardBrand: (pan: string) => pan.startsWith("4") ? "visa" : null,
  extractLast4FromLabel: (label: string) => /^••••\s(\d{4})$/.exec(label)?.[1] ?? null,
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

beforeEach(() => {
  vi.clearAllMocks();
  tbankMock.getTbankConfig.mockReturnValue({
    cardBindAmountKopecks: 100,
  });
  storageMock.getUser.mockResolvedValue({ id: "user-1", role: "rider", email: "rider@example.com", phone: "+79991234567" });
  storageMock.unlinkPaymentMethod.mockResolvedValue(true);
  tbankMock.tbankRemoveCard.mockResolvedValue({ Success: true });
});

describe("payment-method unlink", () => {
  it("revokes a T-Bank CardId before deleting its local reusable token", async () => {
    const { del } = routeApp();
    storageMock.getPaymentMethod.mockResolvedValue({
      id: 10, userId: "user-1", provider: "tbank", type: "card",
      cardId: "card-10", customerKey: "user-1",
    });
    const res = response();

    await del.get("/api/payment-methods/:id")!(
      { session: { userId: "user-1" }, params: { id: "10" }, headers: {}, ip: "203.0.113.10", socket: {} },
      res,
    );

    expect(tbankMock.tbankRemoveCard).toHaveBeenCalledWith(
      expect.objectContaining({ cardBindAmountKopecks: 100 }),
      { customerKey: "user-1", cardId: "card-10", ip: "203.0.113.10" },
    );
    expect(storageMock.unlinkPaymentMethod).toHaveBeenCalledWith("user-1", 10);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("does not remove a card resolved by a webhook before timed-out pending cleanup reaches the server", async () => {
    const { del } = routeApp();
    storageMock.getPaymentMethod.mockResolvedValue({
      id: 12, userId: "user-1", provider: "tbank", type: "card", status: "active",
      cardId: "card-12", customerKey: "user-1",
    });
    const res = response();

    await del.get("/api/payment-methods/:id")!(
      {
        session: { userId: "user-1" }, params: { id: "12" }, query: { pendingOnly: "1" },
        headers: {}, ip: "203.0.113.10", socket: {},
      },
      res,
    );

    expect(tbankMock.tbankRemoveCard).not.toHaveBeenCalled();
    expect(storageMock.unlinkPaymentMethod).not.toHaveBeenCalled();
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: false });
  });
});

describe("T-Bank polling activation duplicate protection", () => {
  it("returns an unchanged AddCard binding while pending without writing updatedAt", async () => {
    const { post } = routeApp();
    const pendingMethod = {
      id: 8, userId: "user-1", provider: "tbank", requestKey: "request-8",
      status: "pending", cardId: null, rebillId: null, brand: null,
      label: "Карта (привязывается…)",
    };
    storageMock.getPaymentMethod.mockResolvedValue(pendingMethod);
    tbankMock.tbankGetAddCardState.mockResolvedValue({
      Success: true, Status: "NEW", CardId: "", RebillId: null,
    });
    const res = response();

    await post.get("/api/payment-methods/:id/refresh")!(
      { session: { userId: "user-1" }, params: { id: "8" } }, res,
    );

    expect(storageMock.updatePaymentMethod).not.toHaveBeenCalled();
    expect(res.body).toEqual(pendingMethod);
  });

  it("returns an unchanged Init binding while pending without writing updatedAt", async () => {
    const { get } = routeApp();
    const pendingMethod = {
      id: 9, userId: "user-1", provider: "tbank", paymentId: "payment-9",
      status: "pending", cardId: null, rebillId: null, brand: null,
      label: "Карта (привязывается…)", amountKopecks: 100,
    };
    storageMock.getPaymentMethod.mockResolvedValue(pendingMethod);
    tbankMock.tbankGetState.mockResolvedValue({
      Success: true, Status: "NEW", CardId: "", RebillId: null,
    });
    const res = response();

    await get.get("/api/payments/tbank/refresh-bind/:paymentMethodId")!(
      { session: { userId: "user-1" }, params: { paymentMethodId: "9" } }, res,
    );

    expect(storageMock.updatePaymentMethod).not.toHaveBeenCalled();
    expect(res.body).toEqual(pendingMethod);
  });

  it("marks a duplicate AddCard polling result failed instead of activating it", async () => {
    const { post } = routeApp();
    storageMock.getPaymentMethod.mockResolvedValue({
      id: 10, userId: "user-1", provider: "tbank", requestKey: "request-1",
      status: "pending", cardId: null, rebillId: null, brand: null,
      label: "Карта (привязывается…)",
    });
    storageMock.findActiveCardDuplicate.mockResolvedValue({ id: 9 });
    tbankMock.tbankGetAddCardState.mockResolvedValue({
      Success: true, Status: "CONFIRMED", CardId: "card-10", RebillId: "rebill-10", Pan: "430000******0777",
    });
    const res = response();

    await post.get("/api/payment-methods/:id/refresh")!({ session: { userId: "user-1" }, params: { id: "10" } }, res);

    expect(storageMock.findActiveCardDuplicate).toHaveBeenCalledWith("user-1", "0777", "visa", 10);
    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(10, {
      status: "failed",
      lastErrorCode: "DUPLICATE_CARD",
      lastErrorMessage: "Эта карта уже привязана к вашему аккаунту.",
      lastErrorDetails: null,
    });
    expect(refundVerificationChargeMock).not.toHaveBeenCalled();
  });

  it("marks a duplicate Init polling result failed and refunds the verification charge", async () => {
    const { get } = routeApp();
    storageMock.getPaymentMethod.mockResolvedValue({
      id: 11, userId: "user-1", provider: "tbank", paymentId: "payment-11",
      status: "pending", cardId: null, rebillId: null, brand: null,
      label: "Карта (привязывается…)", amountKopecks: 100,
    });
    storageMock.findActiveCardDuplicate.mockResolvedValue({ id: 9 });
    tbankMock.tbankGetState.mockResolvedValue({
      Success: true, Status: "AUTHORIZED", CardId: "card-11", RebillId: "rebill-11", Pan: "430000******0777",
    });
    const res = response();

    await get.get("/api/payments/tbank/refresh-bind/:paymentMethodId")!(
      { session: { userId: "user-1" }, params: { paymentMethodId: "11" } }, res,
    );

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(11, {
      status: "failed",
      lastErrorCode: "DUPLICATE_CARD",
      lastErrorMessage: "Эта карта уже привязана к вашему аккаунту.",
      lastErrorDetails: null,
    });
    expect(refundVerificationChargeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cardBindAmountKopecks: 100 }),
      expect.objectContaining({ methodId: 11, paymentId: "payment-11", knownStatus: "AUTHORIZED" }),
    );
  });
});

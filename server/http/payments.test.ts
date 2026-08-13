import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the two polling activation handlers through their registered routes.
// All infrastructure is mocked: this asserts the lifecycle decisions without a
// T-Bank terminal or database.
const storageMock = vi.hoisted(() => ({
  getPaymentMethod: vi.fn(),
  getUser: vi.fn(),
  listPaymentMethods: vi.fn(),
  updatePaymentMethod: vi.fn(),
  findActiveCardDuplicate: vi.fn(),
  unlinkPaymentMethod: vi.fn(),
}));
const tbankMock = vi.hoisted(() => ({
  getTbankConfig: vi.fn(),
  tbankGetAddCardState: vi.fn(),
  tbankGetState: vi.fn(),
  tbankRemoveCard: vi.fn(),
  tbankAddCard: vi.fn(),
}));
const bindViaVerificationPaymentMock = vi.hoisted(() => vi.fn());
const refundVerificationChargeMock = vi.hoisted(() => vi.fn());
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
    tbankGetAddCardState: tbankMock.tbankGetAddCardState,
    tbankGetState: tbankMock.tbankGetState,
    tbankRemoveCard: tbankMock.tbankRemoveCard,
    tbankAddCard: tbankMock.tbankAddCard,
  };
});
vi.mock("../payments/tbank-handlers", () => ({
  startRideForPaidOrder: vi.fn(),
  tbankErrorBody: vi.fn(),
  handleTbankNotification: vi.fn(),
  bindingErrorPatch: vi.fn(() => ({})),
  terminalBindingFailurePatch: vi.fn((body: { Status?: unknown }) => {
    const status = typeof body.Status === "string" ? body.Status.trim().toUpperCase() : "";
    return status === "CANCELED" || status === "CANCELLED"
      ? {
        lastErrorCode: "BINDING_CANCELLED",
        lastErrorMessage: "Привязка отменена.",
        lastErrorDetails: null,
      }
      : {};
  }),
  refundVerificationCharge: refundVerificationChargeMock,
  bindViaVerificationPayment: bindViaVerificationPaymentMock,
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
  storageMock.listPaymentMethods.mockResolvedValue([]);
  tbankMock.tbankRemoveCard.mockResolvedValue({ Success: true });
  bindViaVerificationPaymentMock.mockImplementation(async (_cfg, _userId, res) => {
    res.json({ paymentUrl: "https://pay.example.test/new-bind", method: "payment", methodId: 99 });
  });
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

  it("removes a live pending Init binding before the next bind guard can inspect it", async () => {
    const { del, post } = routeApp();
    let rows = [{
      id: 153, userId: "user-1", provider: "tbank", type: "card", status: "pending",
      requestKey: null, paymentId: "payment-153", cardId: null, customerKey: "user-1",
      label: "Карта (привязывается…)",
    }];
    storageMock.getPaymentMethod.mockImplementation(async (id: number) => (
      rows.find((method) => method.id === id)
    ));
    storageMock.listPaymentMethods.mockImplementation(async (userId: string) => (
      rows.filter((method) => method.userId === userId)
    ));
    storageMock.unlinkPaymentMethod.mockImplementation(async (userId: string, id: number) => {
      const before = rows.length;
      rows = rows.filter((method) => method.userId !== userId || method.id !== id);
      return rows.length !== before;
    });
    // This is the exact production state: the bank still reports NEW, but the
    // rider's timed-out/manual pending cleanup must remove the local lock.
    tbankMock.tbankGetState.mockResolvedValue({ Success: true, Status: "NEW", ErrorCode: "0" });

    const deleteRes = response();
    await del.get("/api/payment-methods/:id")!(
      {
        session: { userId: "user-1" }, params: { id: "153" }, query: { pendingOnly: "1" },
        headers: {}, ip: "203.0.113.10", socket: {},
      },
      deleteRes,
    );

    expect(deleteRes.code).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true, cancelled: true });
    expect(storageMock.unlinkPaymentMethod).toHaveBeenCalledWith("user-1", 153);
    expect(rows).toEqual([]);

    const bindRes = response();
    await post.get("/api/payments/tbank/bind-card")!(
      { session: { userId: "user-1" } },
      bindRes,
    );

    expect(bindRes.code).toBe(200);
    expect(bindViaVerificationPaymentMock).toHaveBeenCalled();
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
      Success: true, Status: "CONFIRMED", CardId: "card-11", RebillId: "rebill-11", Pan: "430000******0777",
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
      expect.objectContaining({ methodId: 11, paymentId: "payment-11", knownStatus: "CONFIRMED" }),
    );
  });
});

describe("authoritative pending card-binding reconciliation", () => {
  function pendingAddCard(overrides: Record<string, unknown> = {}) {
    return {
      id: 31, userId: "user-1", provider: "tbank", type: "card",
      requestKey: "request-31", paymentId: null, status: "pending",
      cardId: null, rebillId: null, brand: null, label: "Карта (привязывается…)",
      ...overrides,
    };
  }

  it.each(["REJECTED", "DEADLINE_EXPIRED", "CANCELED"])(
    "marks an AddCard binding %s failed and lets the client-facing bind endpoint start a new bind",
    async (status) => {
      const { post } = routeApp();
      const method = pendingAddCard();
      storageMock.listPaymentMethods.mockResolvedValue([method]);
      tbankMock.tbankGetAddCardState.mockResolvedValue({ Success: true, Status: status });
      const res = response();

      await post.get("/api/payments/tbank/bind-card")!(
        { session: { userId: "user-1" } }, res,
      );

      expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(31, expect.objectContaining({
        status: "failed",
      }));
      expect(refundVerificationChargeMock).not.toHaveBeenCalled();
      expect(bindViaVerificationPaymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ cardBindAmountKopecks: 100 }),
        "user-1",
        res,
        "rider@example.com",
        "+79991234567",
      );
      expect(res.code).toBe(200);
      expect(res.body).toEqual({
        paymentUrl: "https://pay.example.test/new-bind", method: "payment", methodId: 99,
      });
    },
  );

  it("supersedes an Init binding without waiting for GetState before allowing a retry", async () => {
    const { post } = routeApp();
    const method = pendingAddCard({ requestKey: null, paymentId: "payment-31" });
    storageMock.listPaymentMethods.mockResolvedValue([method]);
    const res = response();

    await post.get("/api/payments/tbank/bind-card")!(
      { session: { userId: "user-1" } }, res,
    );

    expect(tbankMock.tbankGetState).not.toHaveBeenCalled();
    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(31, expect.objectContaining({
      status: "failed",
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    }));
    expect(res.code).toBe(200);
  });

  it("supersedes even an AUTHORIZED Init binding and leaves its late success for the webhook", async () => {
    const { post } = routeApp();
    const method = pendingAddCard({
      requestKey: null,
      paymentId: "payment-authorized",
      purpose: "card_binding",
      amountKopecks: 100,
    });
    storageMock.listPaymentMethods.mockResolvedValue([method]);
    const res = response();

    await post.get("/api/payments/tbank/bind-card")!(
      { session: { userId: "user-1" } }, res,
    );

    expect(tbankMock.tbankGetState).not.toHaveBeenCalled();
    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(31, expect.objectContaining({
      status: "failed",
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    }));
    expect(bindViaVerificationPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ cardBindAmountKopecks: 100 }),
      "user-1",
      res,
      "rider@example.com",
      "+79991234567",
    );
    expect(res.code).toBe(200);
  });

  it("supersedes a pending NEW binding and starts a fresh bind without polling or returning 409", async () => {
    const { post } = routeApp();
    const oldMethod = pendingAddCard({ id: 32, requestKey: "request-old" });
    storageMock.listPaymentMethods.mockResolvedValue([oldMethod]);
    tbankMock.tbankGetAddCardState.mockResolvedValue({ Success: true, Status: "NEW" });
    const res = response();

    await post.get("/api/payments/tbank/bind-card")!(
      { session: { userId: "user-1" } }, res,
    );

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(32, {
      status: "failed",
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
      lastErrorMessage: "Привязка отменена: начата новая попытка.",
      lastErrorDetails: null,
    });
    expect(tbankMock.tbankGetAddCardState).not.toHaveBeenCalled();
    expect(tbankMock.tbankGetState).not.toHaveBeenCalled();
    expect(bindViaVerificationPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ cardBindAmountKopecks: 100 }),
      "user-1",
      res,
      "rider@example.com",
      "+79991234567",
    );
    expect(res.code).toBe(200);
    expect(res.body).toEqual({
      paymentUrl: "https://pay.example.test/new-bind", method: "payment", methodId: 99,
    });
  });

  it("does not let user A's pending row block user B, who has no payment-method rows", async () => {
    const { post } = routeApp();
    const userAPending = pendingAddCard({ id: 41, userId: "user-a" });
    storageMock.getUser.mockResolvedValue({
      id: "user-b", role: "rider", email: "user-b@example.com", phone: "+79990000002",
    });
    storageMock.listPaymentMethods.mockImplementation(async (userId: string) => (
      userId === "user-a" ? [userAPending] : []
    ));
    const res = response();

    await post.get("/api/payments/tbank/bind-card")!(
      { session: { userId: "user-b" } }, res,
    );

    expect(storageMock.listPaymentMethods).toHaveBeenCalledWith("user-b");
    expect(tbankMock.tbankGetAddCardState).not.toHaveBeenCalled();
    expect(res.code).toBe(200);
    expect(bindViaVerificationPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ cardBindAmountKopecks: 100 }),
      "user-b",
      res,
      "user-b@example.com",
      "+79990000002",
    );
  });

  it("supersedes a malformed legacy pending row without a bank call", async () => {
    const { post } = routeApp();
    const method = pendingAddCard({ requestKey: "   ", paymentId: "\t" });
    storageMock.listPaymentMethods.mockResolvedValue([method]);
    tbankMock.tbankGetAddCardState.mockRejectedValue(new Error("bank should not be called"));
    const res = response();

    await post.get("/api/payments/tbank/bind-card")!(
      { session: { userId: "user-1" } }, res,
    );

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(31, expect.objectContaining({
      status: "failed",
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    }));
    expect(tbankMock.tbankGetAddCardState).not.toHaveBeenCalled();
    expect(tbankMock.tbankGetState).not.toHaveBeenCalled();
    expect(res.code).toBe(200);
    expect(bindViaVerificationPaymentMock).toHaveBeenCalled();
  });

  it("reconciles pending cards synchronously before returning the payment-methods page", async () => {
    const { get } = routeApp();
    const method = pendingAddCard();
    storageMock.listPaymentMethods
      .mockResolvedValueOnce([method])
      .mockResolvedValueOnce([{ ...method, status: "failed" }]);
    tbankMock.tbankGetAddCardState.mockResolvedValue({ Success: true, Status: "REJECTED" });
    const res = response();

    await get.get("/api/payment-methods")!({ session: { userId: "user-1" } }, res);

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(31, expect.objectContaining({
      status: "failed",
    }));
    expect(res.body).toEqual([{ ...method, status: "failed" }]);
  });

  it("marks a cancelled Init binding as a benign cancellation during list reconciliation", async () => {
    const { get } = routeApp();
    const method = pendingAddCard({ requestKey: null, paymentId: "payment-cancelled" });
    storageMock.listPaymentMethods
      .mockResolvedValueOnce([method])
      .mockResolvedValueOnce([{
        ...method,
        status: "failed",
        lastErrorCode: "BINDING_CANCELLED",
        lastErrorMessage: "Привязка отменена.",
        lastErrorDetails: null,
      }]);
    tbankMock.tbankGetState.mockResolvedValue({ Success: true, Status: "CANCELED", ErrorCode: "0" });
    const res = response();

    await get.get("/api/payment-methods")!({ session: { userId: "user-1" } }, res);

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(31, {
      status: "failed",
      lastErrorCode: "BINDING_CANCELLED",
      lastErrorMessage: "Привязка отменена.",
      lastErrorDetails: null,
    });
    expect(res.body).toEqual([expect.objectContaining({
      id: 31,
      status: "failed",
      lastErrorCode: "BINDING_CANCELLED",
    })]);
  });

  it("returns superseded rows as failed rather than phantom pending rows from GET /api/payment-methods", async () => {
    const { get } = routeApp();
    const oldMethod = pendingAddCard({ id: 61, requestKey: "request-old" });
    storageMock.listPaymentMethods
      .mockResolvedValueOnce([oldMethod])
      .mockResolvedValueOnce([{
        ...oldMethod,
        status: "failed",
        lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
      }]);
    const res = response();

    await get.get("/api/payment-methods")!({ session: { userId: "user-1" } }, res);

    expect(res.body).toEqual([expect.objectContaining({
      id: 61,
      status: "failed",
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    })]);
    expect((res.body as Array<{ status: string }>).some((method) => method.status === "pending")).toBe(false);
  });
});

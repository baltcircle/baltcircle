// Unit tests for chargeRideOverageAsync (server/storage/ride.ts) — the
// best-effort, post-commit charge of ride overage against the SAME
// card/SBP method that funded the ride. Exercises: card success, card
// decline (-> alert + push, no wallet fallback), pending/3DS (left for the
// webhook), inactive/missing payment method, no acquirer config, and a
// thrown network error mid-charge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentMethod, PaymentOrder, User } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ insert: vi.fn() }));
const sendToUserAsyncMock = vi.hoisted(() => vi.fn());
const tbankMock = vi.hoisted(() => ({
  getTbankConfig: vi.fn(),
  tbankInitSavedCardCharge: vi.fn(),
  tbankCharge: vi.fn(),
  tbankInitSbpCharge: vi.fn(),
  tbankChargeQr: vi.fn(),
  classifyRidePayment: vi.fn(),
  generateOverageChargeOrderId: vi.fn(() => "TROV-test-1"),
}));

vi.mock("./db/bootstrap", () => ({ db: dbMock, pool: { query: vi.fn() }, bootstrapReady: Promise.resolve() }));
vi.mock("./push", () => ({ sendToUserAsync: sendToUserAsyncMock }));
vi.mock("./tbank", () => tbankMock);

import { chargeRideOverageAsync } from "./storage/ride";

function makeMethod(overrides: Partial<PaymentMethod> = {}): PaymentMethod {
  return {
    id: 5, userId: "user-1", type: "card", label: "•••• 4242", brand: "visa",
    status: "active", provider: "tbank", customerKey: "user-1", cardId: "c-1",
    rebillId: "rebill-abc", rebillIdHash: null, accountToken: null, accountTokenHash: null,
    purpose: null, orderId: null, paymentId: null, createdAt: 0,
    ...overrides,
  } as PaymentMethod;
}

function makeFundingOrder(overrides: Partial<PaymentOrder> = {}): PaymentOrder {
  return {
    id: 100, orderId: "TROV-ride-order", userId: "user-1", bikeId: "BC-01",
    tariffId: "h1", amountKopecks: 35000, paymentId: "pay-1", paymentUrl: null,
    source: "saved_card", paymentMethodId: 5, rebillId: "rebill-abc", purpose: null,
    status: "paid", rideId: 42, idempotencyKey: null,
    lastErrorCode: null, lastErrorMessage: null, lastErrorDetails: null,
    createdAt: 0, updatedAt: 0,
    ...overrides,
  } as PaymentOrder;
}

function makeStorage(overrides: Partial<{
  getPaymentMethod: ReturnType<typeof vi.fn>;
  reserveRidePaymentOrder: ReturnType<typeof vi.fn>;
  updateRidePaymentOrder: ReturnType<typeof vi.fn>;
  createOverageChargeFailedAlert: ReturnType<typeof vi.fn>;
  getUser: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    getPaymentMethod: vi.fn(async () => makeMethod()),
    reserveRidePaymentOrder: vi.fn(async () => ({
      order: { id: 200, orderId: "TROV-test-1" } as PaymentOrder, created: true,
    })),
    updateRidePaymentOrder: vi.fn(async () => undefined),
    createOverageChargeFailedAlert: vi.fn(async () => null),
    getUser: vi.fn(async () => ({ id: "user-1", email: "a@b.ru", phone: "+79990000000" } as User)),
    ...overrides,
  };
}

const BASE_ARGS = { rideId: 42, bikeId: "BC-01", userId: "user-1", overageKopecks: 15000, extraMinutes: 20 };

beforeEach(() => {
  vi.clearAllMocks();
  tbankMock.generateOverageChargeOrderId.mockReturnValue("TROV-test-1");
  tbankMock.getTbankConfig.mockReturnValue({ publicAppUrl: "https://app.example.com" });
  dbMock.insert.mockReturnValue({ values: vi.fn(async () => undefined) });
});
afterEach(() => vi.restoreAllMocks());

describe("chargeRideOverageAsync — saved-card success", () => {
  it("inits+charges the saved card, marks the order paid, records the ledger row, and pushes success", async () => {
    tbankMock.tbankInitSavedCardCharge.mockResolvedValue({ Success: true, PaymentId: 777 });
    tbankMock.tbankCharge.mockResolvedValue({ Success: true, Status: "CONFIRMED" });
    tbankMock.classifyRidePayment.mockReturnValue("paid");
    const storage = makeStorage();

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(tbankMock.tbankInitSavedCardCharge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountKopecks: 15000, orderId: "TROV-test-1" }),
    );
    expect(tbankMock.tbankCharge).toHaveBeenCalledWith(expect.anything(), { paymentId: "777", rebillId: "rebill-abc" });
    expect(storage.updateRidePaymentOrder).toHaveBeenCalledWith(200, expect.objectContaining({ status: "paid" }));
    expect(dbMock.insert).toHaveBeenCalled();
    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      title: "Оплата поездки",
      data: expect.objectContaining({ kind: "ride-charge-confirmed", rideId: 42 }),
    }));
    expect(storage.createOverageChargeFailedAlert).not.toHaveBeenCalled();
  });

  it("routes SBP funding orders through tbankInitSbpCharge/tbankChargeQr instead of the card path", async () => {
    tbankMock.tbankInitSbpCharge.mockResolvedValue({ Success: true, PaymentId: 888 });
    tbankMock.tbankChargeQr.mockResolvedValue({ Success: true, Status: "CONFIRMED" });
    tbankMock.classifyRidePayment.mockReturnValue("paid");
    const storage = makeStorage({ getPaymentMethod: vi.fn(async () => makeMethod({ type: "sbp", rebillId: null, accountToken: "acct-tok" })) });

    await chargeRideOverageAsync(storage, {
      ...BASE_ARGS,
      fundingOrder: makeFundingOrder({ source: "saved_sbp", rebillId: null }),
    });

    expect(tbankMock.tbankInitSbpCharge).toHaveBeenCalled();
    expect(tbankMock.tbankChargeQr).toHaveBeenCalledWith(expect.anything(), { paymentId: "888", accountToken: "acct-tok" });
    expect(tbankMock.tbankInitSavedCardCharge).not.toHaveBeenCalled();
  });
});

describe("chargeRideOverageAsync — decline / failure paths (NO wallet fallback)", () => {
  it("on a declined Init, marks the order failed and alerts + pushes the rider — never touches the wallet", async () => {
    tbankMock.tbankInitSavedCardCharge.mockResolvedValue({ Success: false, Message: "Недостаточно средств на карте" });
    const storage = makeStorage();

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(storage.updateRidePaymentOrder).toHaveBeenCalledWith(200, expect.objectContaining({ status: "failed" }));
    expect(storage.createOverageChargeFailedAlert).toHaveBeenCalledWith(
      "BC-01", 42, "user-1", 15000, "Недостаточно средств на карте", expect.any(Number),
    );
    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      title: "Недостаточно средств",
      data: expect.objectContaining({ kind: "ride-overage-failed", rideId: 42 }),
    }));
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("on a declined Charge (Init OK, Charge rejected), marks failed and alerts", async () => {
    tbankMock.tbankInitSavedCardCharge.mockResolvedValue({ Success: true, PaymentId: 777 });
    tbankMock.tbankCharge.mockResolvedValue({ Success: false, Status: "REJECTED", Message: "Card declined" });
    tbankMock.classifyRidePayment.mockReturnValue("failed");
    const storage = makeStorage();

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(storage.updateRidePaymentOrder).toHaveBeenLastCalledWith(200, expect.objectContaining({ status: "failed" }));
    expect(storage.createOverageChargeFailedAlert).toHaveBeenCalled();
  });

  it("leaves the order pending (no alert/push yet) on a 3DS/deferred outcome — the webhook resolves it later", async () => {
    tbankMock.tbankInitSavedCardCharge.mockResolvedValue({ Success: true, PaymentId: 777 });
    tbankMock.tbankCharge.mockResolvedValue({ Success: true, Status: "3DS_CHECKING" });
    tbankMock.classifyRidePayment.mockReturnValue("pending");
    const storage = makeStorage();

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(storage.createOverageChargeFailedAlert).not.toHaveBeenCalled();
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
    // Order is left as-is (only paymentId patched) — no terminal status written.
    expect(storage.updateRidePaymentOrder).toHaveBeenCalledWith(200, { paymentId: "777" });
  });

  it("fails fast (no charge attempted) when the payment method is inactive", async () => {
    const storage = makeStorage({ getPaymentMethod: vi.fn(async () => makeMethod({ status: "failed" })) });

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(tbankMock.tbankInitSavedCardCharge).not.toHaveBeenCalled();
    expect(storage.createOverageChargeFailedAlert).toHaveBeenCalledWith(
      "BC-01", 42, "user-1", 15000, "способ оплаты недоступен", expect.any(Number),
    );
  });

  it("fails fast when the payment method row cannot be found", async () => {
    const storage = makeStorage({ getPaymentMethod: vi.fn(async () => undefined) });

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(storage.reserveRidePaymentOrder).not.toHaveBeenCalled();
    expect(storage.createOverageChargeFailedAlert).toHaveBeenCalled();
  });

  it("fails fast when the acquirer is not configured", async () => {
    tbankMock.getTbankConfig.mockReturnValue(undefined);
    const storage = makeStorage();

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(storage.reserveRidePaymentOrder).not.toHaveBeenCalled();
    expect(storage.createOverageChargeFailedAlert).toHaveBeenCalledWith(
      "BC-01", 42, "user-1", 15000, "платежи не настроены", expect.any(Number),
    );
  });

  it("catches a thrown network error mid-charge, marks the order failed, and still alerts", async () => {
    tbankMock.tbankInitSavedCardCharge.mockResolvedValue({ Success: true, PaymentId: 777 });
    tbankMock.tbankCharge.mockRejectedValue(new Error("socket hang up"));
    const storage = makeStorage();

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(storage.updateRidePaymentOrder).toHaveBeenLastCalledWith(200, expect.objectContaining({ status: "failed" }));
    expect(storage.createOverageChargeFailedAlert).toHaveBeenCalledWith(
      "BC-01", 42, "user-1", 15000, "сетевая ошибка при списании", expect.any(Number),
    );
  });

  it("does not double-charge: a re-entrant call for the same ride (idempotency key already claimed) is a silent no-op", async () => {
    const storage = makeStorage({
      reserveRidePaymentOrder: vi.fn(async () => ({ order: { id: 200 } as PaymentOrder, created: false })),
    });

    await chargeRideOverageAsync(storage, { ...BASE_ARGS, fundingOrder: makeFundingOrder() });

    expect(tbankMock.tbankInitSavedCardCharge).not.toHaveBeenCalled();
    expect(storage.createOverageChargeFailedAlert).not.toHaveBeenCalled();
  });
});

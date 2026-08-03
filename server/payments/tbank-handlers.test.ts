import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PaymentOrder } from "@shared/schema";

// The handlers under test touch the DB via the `storage` singleton and fire push
// notifications; both are mocked so these run as pure unit tests with no live
// Postgres (audit H5). The T-Bank status classifiers (server/tbank.ts) are pure
// and left unmocked so we exercise the real AUTHORIZED/CONFIRMED/REJECTED mapping.
const storageMock = vi.hoisted(() => ({
  getRidePaymentOrder: vi.fn(),
  getActiveRide: vi.fn(),
  startRide: vi.fn(),
  updateRidePaymentOrder: vi.fn(),
  findCardMethodByOrderId: vi.fn(),
  findMethodByRequestKey: vi.fn(),
  findPendingCardMethod: vi.fn(),
  updatePaymentMethod: vi.fn(),
}));

// tbankRefundVerificationCharge is the ONLY function in server/tbank.ts that ever
// calls the acquirer's /Cancel endpoint (see server/tbank.ts). Mocking it here
// lets the "unmatched notification" tests assert, with certainty, that no
// refund/cancel was attempted — not just that no DB row was mutated.
const tbankRefundVerificationChargeMock = vi.hoisted(() => vi.fn());

const logMock = vi.hoisted(() => vi.fn());

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../index", () => ({ log: logMock }));
vi.mock("../push", () => ({ sendToUserAsync: vi.fn() }));
vi.mock("../tbank", async () => {
  const actual = await vi.importActual<typeof import("../tbank")>("../tbank");
  return { ...actual, tbankRefundVerificationCharge: tbankRefundVerificationChargeMock };
});

import {
  startRideForPaidOrder,
  handleRidePaymentNotification,
  handleTbankNotification,
  handleAddCardNotification,
} from "./tbank-handlers";

function makeOrder(overrides: Partial<PaymentOrder> = {}): PaymentOrder {
  return {
    id: 1,
    orderId: "ride-abc",
    userId: "user-1",
    bikeId: "BC-01",
    tariffId: "h2",
    amountKopecks: 30000,
    status: "pending",
    paymentId: null,
    rideId: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastErrorDetails: null,
    ...(overrides as any),
  } as PaymentOrder;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startRideForPaidOrder", () => {
  it("starts a new ride and marks the order paid with the ride id", async () => {
    storageMock.getActiveRide.mockResolvedValue(undefined);
    storageMock.startRide.mockResolvedValue({ id: 42 });

    const res = await startRideForPaidOrder(makeOrder(), "pay-1");

    expect(res).toEqual({ ok: true, rideId: 42 });
    expect(storageMock.startRide).toHaveBeenCalledOnce();
    expect(storageMock.updateRidePaymentOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "paid", rideId: 42, paymentId: "pay-1" }),
    );
  });

  it("is idempotent: an order that already carries a rideId never starts a second ride", async () => {
    const res = await startRideForPaidOrder(makeOrder({ rideId: 99 }), "pay-1");

    expect(res).toEqual({ ok: true, rideId: 99 });
    expect(storageMock.startRide).not.toHaveBeenCalled();
    expect(storageMock.getActiveRide).not.toHaveBeenCalled();
  });

  it("reuses an already-active ride on the same bike instead of starting another", async () => {
    storageMock.getActiveRide.mockResolvedValue({ id: 7, bikeId: "BC-01" });

    const res = await startRideForPaidOrder(makeOrder(), "pay-1");

    expect(res).toEqual({ ok: true, rideId: 7 });
    expect(storageMock.startRide).not.toHaveBeenCalled();
  });

  it("keeps the order paid but reports failure when the ride cannot start", async () => {
    storageMock.getActiveRide.mockResolvedValue(undefined);
    storageMock.startRide.mockResolvedValue({ error: "Велосипед недоступен" });

    const res = await startRideForPaidOrder(makeOrder(), "pay-1");

    expect(res).toEqual({ ok: false, reason: "Велосипед недоступен" });
    expect(storageMock.updateRidePaymentOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "paid", lastErrorMessage: "Велосипед недоступен" }),
    );
  });
});

describe("handleRidePaymentNotification", () => {
  it("starts the ride on a CONFIRMED notification", async () => {
    storageMock.getActiveRide.mockResolvedValue(undefined);
    storageMock.startRide.mockResolvedValue({ id: 42 });

    await handleRidePaymentNotification(makeOrder(), {
      Status: "CONFIRMED",
      PaymentId: "pay-1",
    });

    expect(storageMock.startRide).toHaveBeenCalledOnce();
  });

  it("short-circuits (idempotent) when the order is already paid", async () => {
    await handleRidePaymentNotification(makeOrder({ status: "paid", rideId: 42 }), {
      Status: "CONFIRMED",
      PaymentId: "pay-1",
    });

    expect(storageMock.startRide).not.toHaveBeenCalled();
    expect(storageMock.updateRidePaymentOrder).not.toHaveBeenCalled();
  });

  it("marks the order failed on a REJECTED notification and does not start a ride", async () => {
    await handleRidePaymentNotification(makeOrder(), {
      Status: "REJECTED",
      PaymentId: "pay-1",
      ErrorCode: "101",
      Message: "Отказ",
    });

    expect(storageMock.startRide).not.toHaveBeenCalled();
    expect(storageMock.updateRidePaymentOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "failed", lastErrorCode: "101" }),
    );
  });

  it("leaves the order pending on an intermediate status", async () => {
    await handleRidePaymentNotification(makeOrder(), { Status: "FORM_SHOWED" });

    expect(storageMock.startRide).not.toHaveBeenCalled();
    expect(storageMock.updateRidePaymentOrder).not.toHaveBeenCalled();
  });

  it("processing a duplicate CONFIRMED for an already-paid order is a no-op (webhook retry safety)", async () => {
    // First delivery: pending -> paid.
    storageMock.getActiveRide.mockResolvedValue(undefined);
    storageMock.startRide.mockResolvedValue({ id: 42 });
    const order = makeOrder();
    await handleRidePaymentNotification(order, { Status: "CONFIRMED", PaymentId: "pay-1" });
    expect(storageMock.startRide).toHaveBeenCalledOnce();

    // Retry delivery of the SAME notification, now with status already "paid".
    vi.clearAllMocks();
    await handleRidePaymentNotification(makeOrder({ status: "paid", rideId: 42 }), {
      Status: "CONFIRMED",
      PaymentId: "pay-1",
    });
    expect(storageMock.startRide).not.toHaveBeenCalled();
  });
});

describe("handleTbankNotification routing", () => {
  it("routes a notification carrying our ride OrderId to the ride-payment path", async () => {
    storageMock.getRidePaymentOrder.mockResolvedValue(makeOrder());
    storageMock.getActiveRide.mockResolvedValue(undefined);
    storageMock.startRide.mockResolvedValue({ id: 42 });

    await handleTbankNotification({ OrderId: "ride-abc", Status: "CONFIRMED", PaymentId: "p" });

    expect(storageMock.getRidePaymentOrder).toHaveBeenCalledWith("ride-abc");
    expect(storageMock.startRide).toHaveBeenCalledOnce();
  });

  // Regression test for the auto-refund-of-unmatched-notifications bug: T-Bank's
  // own merchant-cabinet test dashboard ( "Тестировать" ) fires a real,
  // correctly-signed notification straight at our NotificationURL for its own
  // test payments (e.g. "Тест 1. Успешная оплата", test card 4300 0000 0000
  // 0777), WITHOUT ever calling any of our own endpoints first. Its OrderId (and
  // CustomerKey/RequestKey) therefore never correlates to any row in our DB. That
  // must be treated as an ordinary, expected "nothing to do here" case — NOT as a
  // reason to auto-cancel/refund the payment. This test exercises the true
  // end-to-end dispatch path (no order, no card_binding/sbp_binding match, no
  // RequestKey match, no pending CustomerKey match) and asserts the acquirer's
  // /Cancel is never invoked, and that a warning is logged for visibility.
  it("acknowledges a validly-signed notification for an unknown OrderId WITHOUT cancelling/refunding it", async () => {
    storageMock.getRidePaymentOrder.mockResolvedValue(undefined);
    storageMock.findCardMethodByOrderId.mockResolvedValue(undefined);
    storageMock.findMethodByRequestKey.mockResolvedValue(undefined);
    storageMock.findPendingCardMethod.mockResolvedValue(undefined);

    // Mirrors the real production incident: T-Bank's own test-dashboard
    // notification for "Тест 1. Успешная оплата", amount 12390.01 RUB, an
    // OrderId/CustomerKey our app never generated, and no RequestKey.
    await expect(
      handleTbankNotification({
        OrderId: "tbank-dashboard-test-order",
        Status: "CONFIRMED",
        PaymentId: "8979349666",
        Amount: 1239001,
        CustomerKey: "tbank-dashboard-customer",
      }),
    ).resolves.toBeUndefined();

    // The DB was consulted (correlation was attempted)...
    expect(storageMock.getRidePaymentOrder).toHaveBeenCalledWith("tbank-dashboard-test-order");
    expect(storageMock.findCardMethodByOrderId).toHaveBeenCalledWith("tbank-dashboard-test-order");
    expect(storageMock.findPendingCardMethod).toHaveBeenCalledWith("tbank-dashboard-customer");

    // ...but nothing was mutated and, critically, /Cancel was never called.
    expect(storageMock.updatePaymentMethod).not.toHaveBeenCalled();
    expect(storageMock.updateRidePaymentOrder).not.toHaveBeenCalled();
    expect(tbankRefundVerificationChargeMock).not.toHaveBeenCalled();

    // A warning was logged so the gap is observable without silently vanishing.
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("WARN"), "tbank");
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("unmatched"), "tbank");
  });

  it("acknowledges a notification with no OrderId/RequestKey/CustomerKey at all WITHOUT cancelling/refunding", async () => {
    await expect(handleTbankNotification({ Status: "CONFIRMED", PaymentId: "8979349666" })).resolves.toBeUndefined();

    expect(storageMock.updatePaymentMethod).not.toHaveBeenCalled();
    expect(tbankRefundVerificationChargeMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("WARN"), "tbank");
  });

  it("still processes a real, known order normally when both an unmatched-style Amount and a genuine OrderId are present", async () => {
    // Sanity check that the new unmatched-notification guard does not regress the
    // existing, legitimate path: a notification for an order that DOES exist
    // keeps starting the ride as before, and never touches the refund code path
    // (ride payments never call refundVerificationCharge in the first place).
    storageMock.getRidePaymentOrder.mockResolvedValue(makeOrder());
    storageMock.getActiveRide.mockResolvedValue(undefined);
    storageMock.startRide.mockResolvedValue({ id: 42 });

    await handleTbankNotification({
      OrderId: "ride-abc",
      Status: "CONFIRMED",
      PaymentId: "p",
      Amount: 1239001,
    });

    expect(storageMock.startRide).toHaveBeenCalledOnce();
    expect(storageMock.updateRidePaymentOrder).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "paid", rideId: 42 }),
    );
    expect(tbankRefundVerificationChargeMock).not.toHaveBeenCalled();
  });
});

describe("handleAddCardNotification unmatched-notification guard", () => {
  it("logs a warning and does nothing when CustomerKey is absent", async () => {
    await handleAddCardNotification({ Status: "CONFIRMED", PaymentId: "8979349666" });

    expect(storageMock.findPendingCardMethod).not.toHaveBeenCalled();
    expect(storageMock.updatePaymentMethod).not.toHaveBeenCalled();
    expect(tbankRefundVerificationChargeMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("WARN"), "tbank");
  });

  it("logs a warning and does nothing when CustomerKey has no pending method", async () => {
    storageMock.findPendingCardMethod.mockResolvedValue(undefined);

    await handleAddCardNotification({
      Status: "CONFIRMED",
      PaymentId: "8979349666",
      CustomerKey: "tbank-dashboard-customer",
    });

    expect(storageMock.updatePaymentMethod).not.toHaveBeenCalled();
    expect(tbankRefundVerificationChargeMock).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("WARN"), "tbank");
  });

  it("still activates a genuinely pending method on a real match (existing behavior preserved)", async () => {
    storageMock.findPendingCardMethod.mockResolvedValue({
      id: 5,
      cardId: null,
      rebillId: null,
      brand: null,
    });

    await handleAddCardNotification({
      Status: "CONFIRMED",
      CardId: "card-1",
      CustomerKey: "user-1",
    });

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ status: "active", cardId: "card-1" }),
    );
  });
});

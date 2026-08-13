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
  findCardMethodByRequestKey: vi.fn(),
  findMethodByRequestKey: vi.fn(),
  findPendingCardMethod: vi.fn(),
  createPendingBindPayment: vi.fn(),
  getUser: vi.fn(),
  updatePaymentMethod: vi.fn(),
  findActiveCardDuplicate: vi.fn(),
  claimRefund: vi.fn(),
}));

// tbankRefundVerificationCharge is the ONLY function in server/tbank.ts that ever
// calls the acquirer's /Cancel endpoint (see server/tbank.ts). Mocking it here
// lets the "unmatched notification" tests assert, with certainty, that no
// refund/cancel was attempted — not just that no DB row was mutated.
const tbankRefundVerificationChargeMock = vi.hoisted(() => vi.fn());
const tbankInitBindCardMock = vi.hoisted(() => vi.fn());

const logMock = vi.hoisted(() => vi.fn());

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../index", () => ({ log: logMock }));
vi.mock("../push", () => ({ sendToUserAsync: vi.fn() }));
vi.mock("../tbank", async () => {
  const actual = await vi.importActual<typeof import("../tbank")>("../tbank");
  return {
    ...actual,
    tbankInitBindCard: tbankInitBindCardMock,
    tbankRefundVerificationCharge: tbankRefundVerificationChargeMock,
  };
});

import {
  startRideForPaidOrder,
  handleRidePaymentNotification,
  handleTbankNotification,
  handleAddCardNotification,
  handleInitBindingNotification,
  refundVerificationCharge,
  bindViaVerificationPayment,
  extractLast4FromLabel,
} from "./tbank-handlers";
import type { TbankConfig } from "../tbank";

function makeCfg(): TbankConfig {
  return {
    terminalKey: "test-terminal",
    password: "test-password",
    apiBase: "https://securepay.tinkoff.ru/v2",
    publicAppUrl: "https://takeride.ru",
    addCardCheckType: "3DS",
    cardBindAmountKopecks: 100,
    cardBindMethod: "payment",
  } as TbankConfig;
}

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

  it("claims and cancels a fresh Init verification charge after its matching CONFIRMED notification", async () => {
    const freshMethod = {
      id: 138,
      userId: "user-1",
      status: "pending",
      purpose: "card_binding",
      orderId: "bind-fresh",
      paymentId: "verification-payment-1",
      amountKopecks: 100,
      refundStatus: null,
      rebillId: null,
      cardId: null,
      brand: null,
    };
    const response = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;
    tbankInitBindCardMock.mockResolvedValue({
      Success: true,
      PaymentId: "verification-payment-1",
      PaymentURL: "https://securepay.tinkoff.ru/pay/fresh",
    });
    storageMock.createPendingBindPayment.mockResolvedValue(freshMethod);

    await bindViaVerificationPayment(makeCfg(), "user-1", response);

    // A newly-created verification charge remains claimable. In particular,
    // initialization must not preemptively write the in-flight "pending" state.
    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(138, {
      paymentId: "verification-payment-1",
      paymentUrl: "https://securepay.tinkoff.ru/pay/fresh",
    });

    vi.clearAllMocks();
    storageMock.getRidePaymentOrder.mockResolvedValue(undefined);
    storageMock.findCardMethodByOrderId.mockResolvedValue(freshMethod);
    storageMock.getUser.mockResolvedValue({ email: "rider@example.com", phone: "+79991234567" });
    storageMock.claimRefund.mockResolvedValue(true);
    tbankRefundVerificationChargeMock.mockResolvedValue({ result: "refunded", status: "REFUNDED" });

    await handleTbankNotification({
      OrderId: "bind-fresh",
      Status: "CONFIRMED",
      PaymentId: "verification-payment-1",
      RebillId: "rebill-1",
      CardId: "card-1",
      Pan: "430000******0777",
    }, makeCfg());
    // Let the fire-and-forget cancellation completion handler flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(storageMock.claimRefund).toHaveBeenCalledWith(138);
    expect(tbankRefundVerificationChargeMock).toHaveBeenCalledWith(makeCfg(), {
      paymentId: "verification-payment-1",
      knownStatus: "CONFIRMED",
      amountKopecks: 100,
      customerEmail: "rider@example.com",
      customerPhone: "+79991234567",
    });
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

  it("does not resurrect a manually removed Init binding when its delayed notification arrives", async () => {
    // A successful DELETE hard-removes the row. The delayed webhook must only
    // correlate an existing row and never create or re-mark a pending method.
    storageMock.getRidePaymentOrder.mockResolvedValue(undefined);
    storageMock.findCardMethodByOrderId.mockResolvedValue(undefined);
    storageMock.findMethodByRequestKey.mockResolvedValue(undefined);
    storageMock.findPendingCardMethod.mockResolvedValue(undefined);

    await handleTbankNotification({
      OrderId: "bind-153",
      PaymentId: "payment-153",
      Status: "CONFIRMED",
      RebillId: "rebill-153",
      CardId: "card-153",
      CustomerKey: "user-1",
    }, makeCfg());

    expect(storageMock.findCardMethodByOrderId).toHaveBeenCalledWith("bind-153");
    expect(storageMock.updatePaymentMethod).not.toHaveBeenCalled();
    expect(storageMock.createPendingBindPayment).not.toHaveBeenCalled();
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
      type: "card",
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

  it("rejects a duplicate AddCard binding rather than activating a second row", async () => {
    storageMock.findPendingCardMethod.mockResolvedValue({
      id: 6, userId: "user-1", type: "card", cardId: null, rebillId: null, brand: null,
    });
    storageMock.findActiveCardDuplicate.mockResolvedValue({ id: 5 });

    await handleAddCardNotification({
      Status: "CONFIRMED",
      CardId: "card-duplicate",
      CustomerKey: "user-1",
      Pan: "430000******0777",
    });

    expect(storageMock.findActiveCardDuplicate).toHaveBeenCalledWith("user-1", "0777", "visa", 6);
    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(6, {
      status: "failed",
      lastErrorCode: "DUPLICATE_CARD",
      lastErrorMessage: "Эта карта уже привязана к вашему аккаунту.",
      lastErrorDetails: null,
    });
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("last4=0777"), "tbank");
  });

  it("honors a late AddCard success for the superseded row identified by RequestKey", async () => {
    storageMock.findCardMethodByRequestKey.mockResolvedValue({
      id: 7,
      userId: "user-1",
      type: "card",
      status: "failed",
      requestKey: "request-old",
      cardId: null,
      rebillId: null,
      brand: null,
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    });
    storageMock.findActiveCardDuplicate.mockResolvedValue(undefined);

    await handleAddCardNotification({
      Status: "CONFIRMED",
      CardId: "card-old",
      RebillId: "rebill-old",
      CustomerKey: "user-1",
      RequestKey: "request-old",
      Pan: "430000******0777",
    });

    expect(storageMock.findCardMethodByRequestKey).toHaveBeenCalledWith("user-1", "request-old");
    expect(storageMock.findPendingCardMethod).not.toHaveBeenCalled();
    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(7, expect.objectContaining({
      status: "active",
      cardId: "card-old",
      rebillId: "rebill-old",
    }));
  });
});

describe("card-binding duplicate protection", () => {
  const pendingInitMethod = {
    id: 138,
    userId: "user-1",
    status: "pending",
    purpose: "card_binding",
    paymentId: "verification-payment-1",
    rebillId: null,
    cardId: null,
    brand: null,
    amountKopecks: 100,
  } as any;

  it("allows independent activation of two different cards for one rider", async () => {
    storageMock.findActiveCardDuplicate.mockResolvedValue(undefined);

    await handleInitBindingNotification(
      pendingInitMethod,
      { Status: "CONFIRMED", PaymentId: "pay-1", RebillId: "rebill-1", CardId: "card-1", Pan: "430000******0777" },
    );
    await handleInitBindingNotification(
      { ...pendingInitMethod, id: 139, paymentId: "verification-payment-2" },
      { Status: "CONFIRMED", PaymentId: "pay-2", RebillId: "rebill-2", CardId: "card-2", Pan: "555555******4444" },
    );

    expect(storageMock.updatePaymentMethod).toHaveBeenNthCalledWith(
      1, 138, expect.objectContaining({ status: "active", label: "•••• 0777", brand: "visa" }),
    );
    expect(storageMock.updatePaymentMethod).toHaveBeenNthCalledWith(
      2, 139, expect.objectContaining({ status: "active", label: "•••• 4444", brand: "mastercard" }),
    );
  });

  it("fails a duplicate Init binding and triggers a verification-charge refund", async () => {
    storageMock.findActiveCardDuplicate.mockResolvedValue({ id: 137 });
    storageMock.getUser.mockResolvedValue({ email: "rider@example.com", phone: "+79991234567" });
    storageMock.claimRefund.mockResolvedValue(true);
    tbankRefundVerificationChargeMock.mockResolvedValue({ result: "refunded", status: "REFUNDED" });

    await handleInitBindingNotification(
      pendingInitMethod,
      { Status: "CONFIRMED", PaymentId: "verification-payment-1", RebillId: "rebill-2", CardId: "card-2", Pan: "430000******0777" },
      makeCfg(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(138, {
      status: "failed",
      paymentId: "verification-payment-1",
      lastErrorCode: "DUPLICATE_CARD",
      lastErrorMessage: "Эта карта уже привязана к вашему аккаунту.",
      lastErrorDetails: null,
    });
    expect(storageMock.claimRefund).toHaveBeenCalledWith(138);
    expect(tbankRefundVerificationChargeMock).toHaveBeenCalledWith(
      makeCfg(),
      expect.objectContaining({ paymentId: "verification-payment-1", knownStatus: "CONFIRMED" }),
    );
  });

  it("only extracts four digits from the fixed masked-card label", () => {
    expect(extractLast4FromLabel("•••• 0777")).toBe("0777");
    expect(extractLast4FromLabel("Карта")).toBeNull();
    expect(extractLast4FromLabel("•••• 777")).toBeNull();
  });

  it("honors a late AUTHORIZED+RebillId notification for an Init binding superseded locally", async () => {
    const supersededMethod = {
      ...pendingInitMethod,
      id: 140,
      status: "failed",
      orderId: "bind-superseded",
      paymentId: "payment-superseded",
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    };
    storageMock.getRidePaymentOrder.mockResolvedValue(undefined);
    storageMock.findCardMethodByOrderId.mockResolvedValue(supersededMethod);
    storageMock.findActiveCardDuplicate.mockResolvedValue(undefined);

    await handleTbankNotification({
      OrderId: "bind-superseded",
      Status: "AUTHORIZED",
      PaymentId: "payment-superseded",
      RebillId: "rebill-superseded",
      CardId: "card-superseded",
      Pan: "430000******0777",
    });

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(140, expect.objectContaining({
      status: "active",
      paymentId: "payment-superseded",
      rebillId: "rebill-superseded",
      cardId: "card-superseded",
    }));
  });

  it("keeps a superseded Init binding failed when its late notification is rejected", async () => {
    const supersededMethod = {
      ...pendingInitMethod,
      id: 141,
      status: "failed",
      orderId: "bind-superseded-rejected",
      paymentId: "payment-superseded-rejected",
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    };
    storageMock.getRidePaymentOrder.mockResolvedValue(undefined);
    storageMock.findCardMethodByOrderId.mockResolvedValue(supersededMethod);

    await handleTbankNotification({
      OrderId: "bind-superseded-rejected",
      Status: "REJECTED",
      PaymentId: "payment-superseded-rejected",
      ErrorCode: "101",
      Message: "Отказ",
    });

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(141, expect.objectContaining({
      status: "failed",
      paymentId: "payment-superseded-rejected",
      lastErrorCode: "101",
    }));
  });

  it("records a cancelled Init binding as a benign cancellation when the webhook arrives first", async () => {
    const method = {
      ...pendingInitMethod,
      status: "pending",
      orderId: "bind-cancelled",
      paymentId: "payment-cancelled",
    };
    storageMock.getRidePaymentOrder.mockResolvedValue(undefined);
    storageMock.findCardMethodByOrderId.mockResolvedValue(method);

    await handleTbankNotification({
      OrderId: "bind-cancelled",
      Status: "CANCELLED",
      PaymentId: "payment-cancelled",
      ErrorCode: "0",
    });

    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(138, {
      status: "failed",
      paymentId: "payment-cancelled",
      lastErrorCode: "BINDING_CANCELLED",
      lastErrorMessage: "Привязка отменена.",
      lastErrorDetails: null,
    });
  });
});

// Regression coverage for the CustomerKey-collision investigation: the actual
// production incident (PaymentId=8979349666 refunded despite being T-Bank's own
// unmatched dashboard-test notification) is best explained not by a CustomerKey
// collision (our CustomerKey === our own random-UUID userId, never guessable by
// T-Bank's dashboard) but by a concurrency race: the notification webhook
// (handleInitBindingNotification) and the client's own GET
// /api/payments/tbank/refresh-bind/:id polling loop can both independently
// observe the SAME method going "active" and both call refundVerificationCharge
// for the same PaymentId, each firing an independent 3-attempt /Cancel retry
// loop against T-Bank. storage.claimRefund() closes this gap with an atomic
// compare-and-swap; these tests assert the guard actually prevents the double
// /Cancel call.
describe("refundVerificationCharge concurrency guard (claimRefund)", () => {
  it("calls tbankRefundVerificationCharge when it wins the claim", async () => {
    storageMock.claimRefund.mockResolvedValue(true);
    tbankRefundVerificationChargeMock.mockResolvedValue({ result: "refunded", status: "REFUNDED" });

    await refundVerificationCharge(makeCfg(), {
      methodId: 138,
      paymentId: "8979349666",
      knownStatus: "CONFIRMED",
      amountKopecks: 100,
      customerPhone: "+79991234567",
    });
    // let the fire-and-forget .then() chain flush
    await new Promise((r) => setTimeout(r, 0));

    expect(storageMock.claimRefund).toHaveBeenCalledWith(138);
    expect(tbankRefundVerificationChargeMock).toHaveBeenCalledWith(makeCfg(), {
      paymentId: "8979349666",
      knownStatus: "CONFIRMED",
      amountKopecks: 100,
      customerEmail: undefined,
      customerPhone: "+79991234567",
    });
    expect(storageMock.updatePaymentMethod).toHaveBeenCalledWith(
      138,
      expect.objectContaining({ refundStatus: "refunded" }),
    );
  });

  it("does NOT call tbankRefundVerificationCharge (does not touch /Cancel) when the claim is lost to a concurrent caller", async () => {
    // Simulates the exact race: the webhook and the refresh-bind poll both see
    // outcome === "active" for the same method around the same time; only the
    // first to reach claimRefund() should ever touch the acquirer.
    storageMock.claimRefund.mockResolvedValue(false);

    await refundVerificationCharge(makeCfg(), {
      methodId: 138,
      paymentId: "8979349666",
      knownStatus: "CONFIRMED",
      amountKopecks: 100,
      customerPhone: "+79991234567",
    });

    expect(storageMock.claimRefund).toHaveBeenCalledWith(138);
    expect(tbankRefundVerificationChargeMock).not.toHaveBeenCalled();
    // No unconditional refundStatus="pending" write either — the loser makes no
    // DB mutation at all beyond the failed claim attempt itself.
    expect(storageMock.updatePaymentMethod).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("SKIP"), "tbank");
  });

  it("simultaneous webhook + poll callers: only one ever reaches tbankRefundVerificationCharge", async () => {
    // First caller (e.g. the webhook) wins the claim; second caller (e.g. the
    // concurrent refresh-bind poll tick) loses it. Mirrors two overlapping
    // observations of the same activation for methodId=138.
    storageMock.claimRefund.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    tbankRefundVerificationChargeMock.mockResolvedValue({ result: "refunded", status: "REFUNDED" });

    await Promise.all([
      refundVerificationCharge(makeCfg(), {
        methodId: 138,
        paymentId: "8979349666",
        knownStatus: "CONFIRMED",
        amountKopecks: 100,
        customerPhone: "+79991234567",
      }),
      refundVerificationCharge(makeCfg(), {
        methodId: 138,
        paymentId: "8979349666",
        knownStatus: "CONFIRMED",
        amountKopecks: 100,
        customerPhone: "+79991234567",
      }),
    ]);
    await new Promise((r) => setTimeout(r, 0));

    expect(storageMock.claimRefund).toHaveBeenCalledTimes(2);
    // Exactly one /Cancel attempt for the shared PaymentId, never two.
    expect(tbankRefundVerificationChargeMock).toHaveBeenCalledTimes(1);
  });
});

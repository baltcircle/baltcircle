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

vi.mock("../storage", () => ({ storage: storageMock }));
vi.mock("../index", () => ({ log: vi.fn() }));
vi.mock("../push", () => ({ sendToUserAsync: vi.fn() }));

import {
  startRideForPaidOrder,
  handleRidePaymentNotification,
  handleTbankNotification,
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
});

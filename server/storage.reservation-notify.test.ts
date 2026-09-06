// Уведомления по броням: предупреждение «осталось 2 мин.»
// (ReservationMixin.notifyReservationsNearingExpiry) и push об аннулировании
// из expireOverdueReservations.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reservation } from "@shared/schema";
import { RESERVATION_BIT_WARN_2MIN } from "@shared/reservation-expiry";

const selectRows = vi.hoisted(() => ({ value: [] as unknown[] }));
const executeMock = vi.hoisted(() => vi.fn());
const txExecuteMock = vi.hoisted(() => vi.fn());
const sendToUserAsyncMock = vi.hoisted(() => vi.fn());

const dbMock = vi.hoisted(() => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => selectRows.value),
    })),
  })),
  execute: executeMock,
  transaction: vi.fn(async (fn: (tx: { execute: typeof txExecuteMock }) => Promise<void>) => {
    await fn({ execute: txExecuteMock });
  }),
  insert: vi.fn(),
}));

vi.mock("./db/bootstrap", () => ({ db: dbMock, pool: { query: vi.fn() }, bootstrapReady: Promise.resolve() }));
vi.mock("./push", () => ({ sendToUserAsync: sendToUserAsyncMock }));
vi.mock("./omni/gateway", () => ({ getLockGateway: () => null }));

import { ReservationMixin } from "./storage/reservation";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

const storage = new (ReservationMixin(class {
  invalidateBikesCache() { /* noop */ }
}))() as unknown as {
  notifyReservationsNearingExpiry(now?: number): Promise<number>;
  expireOverdueReservations(): Promise<number>;
};

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 7, bikeId: "BC-014", userId: "user-1",
    createdAt: NOW - 8 * MIN,
    expiresAt: NOW + 2 * MIN,
    status: "active", claimedRideId: null, notifiedMask: 0,
    ...overrides,
  } as Reservation;
}

beforeEach(() => {
  selectRows.value = [];
  executeMock.mockReset();
  executeMock.mockResolvedValue({ rows: [{ id: 7 }] });
  txExecuteMock.mockReset();
  txExecuteMock.mockResolvedValue({ rows: [] });
  sendToUserAsyncMock.mockReset();
});

describe("notifyReservationsNearingExpiry", () => {
  it("предупреждает с номером велосипеда и тегом брони", async () => {
    selectRows.value = [makeReservation()];

    await expect(storage.notifyReservationsNearingExpiry(NOW)).resolves.toBe(1);
    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      url: "/",
      tag: "reservation:7",
      title: "Бронь: осталось 2 мин.",
      data: expect.objectContaining({ kind: "reservation-expiring", reservationId: 7, bikeId: "BC-014" }),
    }));
  });

  it("сначала занимает строку, только потом отправляет push", async () => {
    const order: string[] = [];
    executeMock.mockImplementation(async () => { order.push("claim"); return { rows: [{ id: 7 }] }; });
    sendToUserAsyncMock.mockImplementation(() => { order.push("push"); });
    selectRows.value = [makeReservation()];

    await storage.notifyReservationsNearingExpiry(NOW);
    expect(order).toEqual(["claim", "push"]);
  });

  it("проигранная гонка не шлёт push", async () => {
    // Бронь отменили или превратили в аренду между выборкой и отправкой.
    executeMock.mockResolvedValue({ rows: [] });
    selectRows.value = [makeReservation()];

    await expect(storage.notifyReservationsNearingExpiry(NOW)).resolves.toBe(0);
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });

  it("уже предупреждённую бронь пропускает без записи", async () => {
    selectRows.value = [makeReservation({ notifiedMask: RESERVATION_BIT_WARN_2MIN })];

    await expect(storage.notifyReservationsNearingExpiry(NOW)).resolves.toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("ошибка на одной брони не срывает остальные", async () => {
    executeMock
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValue({ rows: [{ id: 8 }] });
    selectRows.value = [makeReservation({ id: 7 }), makeReservation({ id: 8, userId: "user-2" })];

    await expect(storage.notifyReservationsNearingExpiry(NOW)).resolves.toBe(1);
    expect(sendToUserAsyncMock).toHaveBeenCalledTimes(1);
    expect(sendToUserAsyncMock.mock.calls[0][0]).toBe("user-2");
  });
});

describe("expireOverdueReservations", () => {
  it("уведомляет владельца об аннулировании тем же тегом", async () => {
    // Тег совпадает с предупреждением «осталось 2 мин.» — карточка
    // заменяется, а не ложится второй.
    txExecuteMock
      .mockResolvedValueOnce({ rows: [{ id: 7, bike_id: "BC-014", user_id: "user-1" }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rows: [] })                                                // UPDATE reservations
      .mockResolvedValueOnce({ rows: [{ lock_imei: null }] });                            // UPDATE bikes

    await expect(storage.expireOverdueReservations()).resolves.toBe(1);
    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      tag: "reservation:7",
      title: "Бронь отменена",
      data: expect.objectContaining({ kind: "reservation-expired", reservationId: 7 }),
    }));
  });

  it("ничего не шлёт, когда просроченных броней нет", async () => {
    txExecuteMock.mockResolvedValue({ rows: [] });

    await expect(storage.expireOverdueReservations()).resolves.toBe(0);
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });

  it("не шлёт push, если транзакция упала", async () => {
    // Откатившееся аннулирование не должно оставить райдера с уведомлением о
    // снятой брони, которая на самом деле жива.
    txExecuteMock.mockRejectedValue(new Error("serialization failure"));

    await expect(storage.expireOverdueReservations()).rejects.toThrow();
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });
});

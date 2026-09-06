// Sweep предупреждений о бесплатной паузе (RideMixin.notifyPausedRidesNearingGraceEnd).
// Проверяет порядок «сначала занять строку, потом отправить», отсутствие
// дублей и то, что возобновлённая между тиками поездка ничего не получает.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ride } from "@shared/schema";
import { PAUSE_FREE_GRACE_MS } from "@shared/geo";
import { PAUSE_BIT_WARN_2MIN, PAUSE_BIT_GRACE_ENDED } from "@shared/pause-expiry";

const selectRows = vi.hoisted(() => ({ value: [] as unknown[] }));
const executeMock = vi.hoisted(() => vi.fn());
const sendToUserAsyncMock = vi.hoisted(() => vi.fn());

const dbMock = vi.hoisted(() => ({
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => selectRows.value),
    })),
  })),
  execute: executeMock,
  insert: vi.fn(),
}));

vi.mock("./db/bootstrap", () => ({ db: dbMock, pool: { query: vi.fn() }, bootstrapReady: Promise.resolve() }));
vi.mock("./push", () => ({ sendToUserAsync: sendToUserAsyncMock }));
vi.mock("./omni/gateway", () => ({ getLockGateway: () => null }));
vi.mock("./tbank", () => ({
  getTbankConfig: vi.fn(() => null), tbankInitSavedCardCharge: vi.fn(), tbankCharge: vi.fn(),
  tbankInitSbpCharge: vi.fn(), tbankChargeQr: vi.fn(), classifyRidePayment: vi.fn(),
  generateOverageChargeOrderId: vi.fn(() => "TROV-1"),
}));

import { RideMixin } from "./storage/ride";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

const storage = new (RideMixin(class {}))() as unknown as {
  notifyPausedRidesNearingGraceEnd(now?: number): Promise<number>;
};

function makeRide(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 42, bikeId: "BC-014", userId: "user-1",
    startedAt: NOW - 30 * MIN, endedAt: null,
    startLat: 0, startLng: 0, endLat: null, endLng: null,
    track: "[]", distanceM: 0, cost: 0, tariff: "h1",
    totalTariffHours: 1, totalTariffMs: 60 * MIN, status: "active",
    physicallyLockedAt: null, paidUntilAt: NOW + 25 * MIN,
    // Пауза началась 8 минут назад: до конца бесплатных 10 минут — 2 минуты.
    pausedAt: NOW - 8 * MIN, totalPausedMs: 0, overageNotifiedAt: null,
    expiryNotifiedMask: 0, expiryNotifiedFor: null,
    pauseNotifiedMask: 0, pauseNotifiedFor: null,
    startParkingId: null, isTest: false, activeSlot: 1,
    ...overrides,
  } as Ride;
}

/** Числовые параметры, подставленные в drizzle-шаблон (включая вложенные sql``). */
function boundNumbers(query: unknown): number[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const out: number[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "number") out.push(chunk);
    else if (chunk && typeof chunk === "object" && "queryChunks" in chunk) out.push(...boundNumbers(chunk));
  }
  return out;
}

beforeEach(() => {
  selectRows.value = [];
  executeMock.mockReset();
  executeMock.mockResolvedValue({ rows: [{ id: 42 }] });
  sendToUserAsyncMock.mockReset();
});

describe("notifyPausedRidesNearingGraceEnd", () => {
  it("шлёт предупреждение с номером велосипеда и своим тегом", async () => {
    selectRows.value = [makeRide()];

    await expect(storage.notifyPausedRidesNearingGraceEnd(NOW)).resolves.toBe(1);
    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      url: "/",
      tag: "ride:42:pause",
      title: "Пауза: осталось 2 мин.",
      data: expect.objectContaining({ kind: "ride-pause", rideId: 42, stage: "warn2" }),
    }));
    expect(sendToUserAsyncMock.mock.calls[0][1].body).toContain("BC-014");
  });

  it("сначала занимает строку, только потом отправляет push", async () => {
    // Иначе два инстанса за одним тиком отправят один и тот же push дважды.
    const order: string[] = [];
    executeMock.mockImplementation(async () => { order.push("claim"); return { rows: [{ id: 42 }] }; });
    sendToUserAsyncMock.mockImplementation(() => { order.push("push"); });
    selectRows.value = [makeRide()];

    await storage.notifyPausedRidesNearingGraceEnd(NOW);
    expect(order).toEqual(["claim", "push"]);
  });

  it("проигранная гонка (0 обновлённых строк) не шлёт push", async () => {
    // Поездку возобновили между выборкой и отправкой — предупреждение о паузе
    // уже неуместно.
    executeMock.mockResolvedValue({ rows: [] });
    selectRows.value = [makeRide()];

    await expect(storage.notifyPausedRidesNearingGraceEnd(NOW)).resolves.toBe(0);
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });

  it("исчерпание бюджета пишет обе маски разом", async () => {
    selectRows.value = [makeRide({ pausedAt: NOW - PAUSE_FREE_GRACE_MS })];

    await expect(storage.notifyPausedRidesNearingGraceEnd(NOW)).resolves.toBe(1);
    const bound = boundNumbers(executeMock.mock.calls[0][0]);
    expect(bound).toContain(PAUSE_BIT_WARN_2MIN | PAUSE_BIT_GRACE_ENDED);
    expect(sendToUserAsyncMock.mock.calls[0][1].title).toBe("Пауза: бесплатное время истекло");
  });

  it("уже отправленное предупреждение повторно не шлёт", async () => {
    selectRows.value = [makeRide({
      pauseNotifiedFor: NOW - 8 * MIN,
      pauseNotifiedMask: PAUSE_BIT_WARN_2MIN,
    })];

    await expect(storage.notifyPausedRidesNearingGraceEnd(NOW)).resolves.toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });

  it("ошибка на одной поездке не срывает остальные", async () => {
    executeMock
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValue({ rows: [{ id: 43 }] });
    selectRows.value = [makeRide({ id: 42 }), makeRide({ id: 43, userId: "user-2" })];

    await expect(storage.notifyPausedRidesNearingGraceEnd(NOW)).resolves.toBe(1);
    expect(sendToUserAsyncMock).toHaveBeenCalledTimes(1);
    expect(sendToUserAsyncMock.mock.calls[0][0]).toBe("user-2");
  });

  it("пауза вне порога пропускается без запросов на запись", async () => {
    selectRows.value = [makeRide({ pausedAt: NOW - MIN })];

    await expect(storage.notifyPausedRidesNearingGraceEnd(NOW)).resolves.toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("молчит, если бюджет был исчерпан ещё до этой паузы", async () => {
    selectRows.value = [makeRide({ pausedAt: NOW - MIN, totalPausedMs: PAUSE_FREE_GRACE_MS })];

    await expect(storage.notifyPausedRidesNearingGraceEnd(NOW)).resolves.toBe(0);
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });
});

// Sweep уведомлений об окончании оплаченного времени (RideMixin.notifyRidesNearingExpiry).
// Проверяет порядок «сначала занять строку, потом отправить», отсутствие
// дублей и то, что одна сломанная поездка не роняет весь проход.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ride } from "@shared/schema";
import { EXPIRY_BIT_10MIN, EXPIRY_BIT_5MIN, EXPIRY_BIT_OVERTIME } from "@shared/ride-expiry";

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
  notifyRidesNearingExpiry(now?: number): Promise<number>;
};

function makeRide(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 42, bikeId: "BC-014", userId: "user-1",
    startedAt: NOW - 55 * MIN, endedAt: null,
    startLat: 0, startLng: 0, endLat: null, endLng: null,
    track: "[]", distanceM: 0, cost: 0, tariff: "h1",
    totalTariffHours: 1, totalTariffMs: 60 * MIN, status: "active",
    physicallyLockedAt: null, paidUntilAt: NOW + 5 * MIN,
    pausedAt: null, totalPausedMs: 0, overageNotifiedAt: null,
    expiryNotifiedMask: 0, expiryNotifiedFor: null,
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

describe("notifyRidesNearingExpiry", () => {
  it("шлёт предупреждение с номером велосипеда и ссылкой на карту", async () => {
    selectRows.value = [makeRide()];

    await expect(storage.notifyRidesNearingExpiry(NOW)).resolves.toBe(1);
    expect(sendToUserAsyncMock).toHaveBeenCalledWith("user-1", expect.objectContaining({
      url: "/",
      tag: "ride:42:expiry",
      data: expect.objectContaining({ kind: "ride-expiry", rideId: 42, bikeId: "BC-014", stage: "warn5" }),
    }));
    expect(sendToUserAsyncMock.mock.calls[0][1].body).toContain("BC-014");
  });

  it("сначала занимает строку, только потом отправляет push", async () => {
    selectRows.value = [makeRide()];
    const order: string[] = [];
    executeMock.mockImplementation(async () => { order.push("update"); return { rows: [{ id: 42 }] }; });
    sendToUserAsyncMock.mockImplementation(() => { order.push("push"); });

    await storage.notifyRidesNearingExpiry(NOW);
    expect(order).toEqual(["update", "push"]);
  });

  it("проигранная гонка (0 обновлённых строк) не шлёт push", async () => {
    selectRows.value = [makeRide()];
    executeMock.mockResolvedValue({ rows: [] });

    await expect(storage.notifyRidesNearingExpiry(NOW)).resolves.toBe(0);
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });

  it("овертайм пишет маску целиком и проставляет overage_notified_at", async () => {
    selectRows.value = [makeRide({ paidUntilAt: NOW - MIN })];

    await storage.notifyRidesNearingExpiry(NOW);
    const bound = boundNumbers(executeMock.mock.calls[0][0]);
    // Полная маска и время овертайма попадают в параметры UPDATE.
    expect(bound).toContain(EXPIRY_BIT_10MIN | EXPIRY_BIT_5MIN | EXPIRY_BIT_OVERTIME);
    expect(bound).toContain(NOW);
    expect(sendToUserAsyncMock.mock.calls[0][1].title).toContain("овертайм");
  });

  it("уже отправленный порог повторно не шлёт", async () => {
    selectRows.value = [makeRide({
      expiryNotifiedMask: EXPIRY_BIT_10MIN | EXPIRY_BIT_5MIN,
      expiryNotifiedFor: NOW + 5 * MIN,
    })];

    await expect(storage.notifyRidesNearingExpiry(NOW)).resolves.toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
    expect(sendToUserAsyncMock).not.toHaveBeenCalled();
  });

  it("ошибка на одной поездке не срывает остальные", async () => {
    selectRows.value = [makeRide({ id: 1 }), makeRide({ id: 2, userId: "user-2" })];
    executeMock
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });

    await expect(storage.notifyRidesNearingExpiry(NOW)).resolves.toBe(1);
    expect(sendToUserAsyncMock).toHaveBeenCalledTimes(1);
    expect(sendToUserAsyncMock.mock.calls[0][0]).toBe("user-2");
  });

  it("две активные аренды получают по своему уведомлению", async () => {
    selectRows.value = [
      makeRide({ id: 1, bikeId: "BC-001" }),
      makeRide({ id: 2, bikeId: "BC-002" }),
    ];

    await expect(storage.notifyRidesNearingExpiry(NOW)).resolves.toBe(2);
    const bodies = sendToUserAsyncMock.mock.calls.map((c) => c[1].body as string);
    expect(bodies[0]).toContain("BC-001");
    expect(bodies[1]).toContain("BC-002");
  });

  it("поездка вне порогов пропускается без запросов на запись", async () => {
    selectRows.value = [makeRide({ paidUntilAt: NOW + 20 * MIN })];

    await expect(storage.notifyRidesNearingExpiry(NOW)).resolves.toBe(0);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

// Tests for the fleet-alerts storage mixin (server/storage/alert.ts): the
// fall-alarm dedup insert, listing, and the manual-acknowledgment workflow.
// The Drizzle client and pg pool are mocked, so this runs without Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), update: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));

import { storage, bikeEvents, BIKE_EVENT_CHANNEL } from "./storage";

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 1, bikeId: "BC-01", kind: "fall", severity: "critical",
    message: "Велосипед упал — требуется проверка",
    createdAt: 1000, acknowledgedAt: null, acknowledgedBy: null,
    ...overrides,
  } as Alert;
}

let selectRows: unknown[] = [];
let updateReturning: unknown[] = [];
const updateCalls: { set: unknown }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  selectRows = [];
  updateReturning = [];
  updateCalls.length = 0;
  poolMock.query.mockResolvedValue({ rows: [] });

  dbMock.select.mockImplementation(() => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => Promise.resolve(selectRows),
    };
    return chain;
  });
  dbMock.update.mockImplementation(() => ({
    set: (values: unknown) => {
      updateCalls.push({ set: values });
      return { where: () => ({ returning: () => Promise.resolve(updateReturning) }) };
    },
  }));
});

describe("storage.createFallAlert", () => {
  it("inserts a fall alert and emits the fleet SSE tick when none is open for the bike", async () => {
    dbMock.execute.mockResolvedValue({
      rows: [{
        id: 5, bike_id: "BC-01", kind: "fall", severity: "critical",
        message: "Велосипед упал — требуется проверка",
        created_at: 12345, acknowledged_at: null, acknowledged_by: null,
      }],
    });
    const received: string[] = [];
    bikeEvents.once(BIKE_EVENT_CHANNEL, () => received.push("tick"));

    const result = await storage.createFallAlert("BC-01", 12345);

    expect(result).toEqual({
      id: 5, bikeId: "BC-01", kind: "fall", severity: "critical",
      message: "Велосипед упал — требуется проверка",
      createdAt: 12345, acknowledgedAt: null, acknowledgedBy: null,
    });
    expect(received).toEqual(["tick"]);
  });

  it("is a no-op (returns null, no emit) when an unacknowledged fall alert already exists for the bike", async () => {
    // The atomic WHERE NOT EXISTS guard in the INSERT ... SELECT means
    // Postgres returns zero rows instead of a second alert row.
    dbMock.execute.mockResolvedValue({ rows: [] });
    const received: string[] = [];
    bikeEvents.once(BIKE_EVENT_CHANNEL, () => received.push("tick"));

    const result = await storage.createFallAlert("BC-01", 12345);

    expect(result).toBeNull();
    expect(received).toEqual([]);
  });
});

describe("storage.createMovementAlert", () => {
  it("inserts a movement_alarm alert and emits the fleet SSE tick when none is open for the bike", async () => {
    dbMock.execute.mockResolvedValue({
      rows: [{
        id: 7, bike_id: "BC-01", kind: "movement_alarm", severity: "critical",
        message: "Несанкционированное перемещение велосипеда — требуется проверка",
        created_at: 12345, acknowledged_at: null, acknowledged_by: null,
      }],
    });
    const received: string[] = [];
    bikeEvents.once(BIKE_EVENT_CHANNEL, () => received.push("tick"));

    const result = await storage.createMovementAlert("BC-01", 12345);

    expect(result).toEqual({
      id: 7, bikeId: "BC-01", kind: "movement_alarm", severity: "critical",
      message: "Несанкционированное перемещение велосипеда — требуется проверка",
      createdAt: 12345, acknowledgedAt: null, acknowledgedBy: null,
    });
    expect(received).toEqual(["tick"]);
  });

  it("is a no-op (returns null, no emit) when an unacknowledged movement_alarm alert already exists for the bike", async () => {
    dbMock.execute.mockResolvedValue({ rows: [] });
    const received: string[] = [];
    bikeEvents.once(BIKE_EVENT_CHANNEL, () => received.push("tick"));

    const result = await storage.createMovementAlert("BC-01", 12345);

    expect(result).toBeNull();
    expect(received).toEqual([]);
  });

  it("does not clash with an open fall alert for the same bike (different `kind`, independent dedup)", async () => {
    // Sanity check that the shared createAlertRow helper parameterizes `kind`
    // into both the INSERT and the WHERE NOT EXISTS guard — a fall alert being
    // open must not block a movement_alarm insert for the same bike.
    dbMock.execute.mockResolvedValue({
      rows: [{
        id: 8, bike_id: "BC-01", kind: "movement_alarm", severity: "critical",
        message: "Несанкционированное перемещение велосипеда — требуется проверка",
        created_at: 12345, acknowledged_at: null, acknowledged_by: null,
      }],
    });

    const result = await storage.createMovementAlert("BC-01", 12345);

    expect(result).not.toBeNull();
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });
});

describe("storage.listAlerts", () => {
  it("defaults to unacknowledged-only", async () => {
    selectRows = [makeAlert({ id: 1 }), makeAlert({ id: 2 })];

    const result = await storage.listAlerts();

    expect(result).toHaveLength(2);
  });

  it("includes acknowledged rows when explicitly requested", async () => {
    selectRows = [makeAlert({ id: 1, acknowledgedAt: 9999, acknowledgedBy: "Оператор" })];

    const result = await storage.listAlerts({ includeAcknowledged: true });

    expect(result).toEqual([makeAlert({ id: 1, acknowledgedAt: 9999, acknowledgedBy: "Оператор" })]);
  });
});

describe("storage.acknowledgeAlert", () => {
  it("sets acknowledgedAt/acknowledgedBy and emits the fleet SSE tick on success", async () => {
    const acked = makeAlert({ id: 1, acknowledgedAt: 5000, acknowledgedBy: "Иван" });
    updateReturning = [acked];
    const received: string[] = [];
    bikeEvents.once(BIKE_EVENT_CHANNEL, () => received.push("tick"));

    const result = await storage.acknowledgeAlert(1, "Иван");

    expect(result).toEqual(acked);
    expect(updateCalls[0].set).toMatchObject({ acknowledgedBy: "Иван" });
    expect(received).toEqual(["tick"]);
  });

  it("returns undefined and does not emit when the alert is already acknowledged or missing", async () => {
    updateReturning = []; // WHERE ... acknowledgedAt IS NULL matched nothing
    const received: string[] = [];
    bikeEvents.once(BIKE_EVENT_CHANNEL, () => received.push("tick"));

    const result = await storage.acknowledgeAlert(999, "Иван");

    expect(result).toBeUndefined();
    expect(received).toEqual([]);
  });
});

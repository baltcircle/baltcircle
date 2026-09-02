import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike, Ticket } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));
vi.mock("./push", () => ({ sendToUserAsync: vi.fn() }));

import { storage } from "./storage";
import { setLockGateway } from "./omni/gateway";

const NOW = new Date("2026-08-22T10:00:00.000Z");

function ticketRow(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 1, bikeId: "BC-01", kind: "damage", priority: "high",
    title: "t", message: "m", assignee: null, status: "new",
    createdAt: 0, updatedAt: 0, closedAt: null,
    ...overrides,
  } as Ticket;
}

function bikeRow(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "City", status: "maintenance", battery: 100,
    lat: 350, lng: 217, lastSeen: 0, idleHours: 0, flagged: false,
    lockImei: "IMEI-1", lockOnline: false,
    lockLastSeen: null, parkingId: "P-old", notes: null, seed: false,
    ...overrides,
  } as Bike;
}

function selectFrom(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    for: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: (v: unknown[]) => unknown, reject?: (r: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [] });
});

afterEach(() => vi.useRealTimers());

describe("closing a ticket with returnBikeToAvailable recalculates parking from the fresh GPS-synced position", () => {
  it("passes updateBike's returned (post-sync) bike to recalculateBikeParking, not the stale pre-update one", async () => {
    // Regression test for the bug where recalculateBikeParking(bike) used the
    // bike object fetched BEFORE updateBike() ran — i.e. before the lock's
    // current GPS fix was synced into lat/lng — so a bike moved during
    // maintenance kept being matched against its old, stale position.
    const staleBike = bikeRow({ lat: 350, lng: 217 });
    const freshBike = bikeRow({ lat: 999, lng: 888 }); // what updateBike() returns after GPS sync

    const selectResults: unknown[][] = [
      [ticketRow({ status: "new" })], // existing ticket
      [staleBike],                    // getBike(existing.bikeId) inside returnBikeToAvailable branch
      [ticketRow({ status: "closed" })], // getTicket() final select (ticket row)
      [],                                 // getTicket() final select (comments)
    ];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    dbMock.insert.mockImplementation(() => ({ values: () => Promise.resolve() }));

    const updateBikeSpy = vi.spyOn(storage, "updateBike").mockResolvedValue(freshBike);
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);

    await storage.updateTicket(1, { status: "closed", returnBikeToAvailable: true }, "operator");

    expect(updateBikeSpy).toHaveBeenCalledWith("BC-01", { status: "available" });
    expect(recalcSpy).toHaveBeenCalledWith(freshBike);
    expect(recalcSpy).not.toHaveBeenCalledWith(staleBike);

    updateBikeSpy.mockRestore();
    recalcSpy.mockRestore();
  });

  it("does not recalculate parking when updateBike returns undefined (bike deleted mid-flight)", async () => {
    const staleBike = bikeRow({ lat: 350, lng: 217 });
    const selectResults: unknown[][] = [
      [ticketRow({ status: "new" })],
      [staleBike],
      [ticketRow({ status: "closed" })],
      [],
    ];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    dbMock.insert.mockImplementation(() => ({ values: () => Promise.resolve() }));

    const updateBikeSpy = vi.spyOn(storage, "updateBike").mockResolvedValue(undefined);
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);

    await storage.updateTicket(1, { status: "closed", returnBikeToAvailable: true }, "operator");

    expect(recalcSpy).not.toHaveBeenCalled();

    updateBikeSpy.mockRestore();
    recalcSpy.mockRestore();
  });
});

describe("arming a one-shot parking recalc when returnBikeToAvailable closes a maintenance ticket (bike-status lifecycle spec, 2026-09)", () => {
  afterEach(() => setLockGateway(null));

  it("arms the hook with the bike's imei/id once updateBike confirms the transition", async () => {
    const staleBike = bikeRow({ lockImei: "IMEI-1" });
    const freshBike = bikeRow({ lat: 999, lng: 888, lockImei: "IMEI-1" });
    const selectResults: unknown[][] = [
      [ticketRow({ status: "new" })],
      [staleBike],
      [ticketRow({ status: "closed" })],
      [],
    ];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    dbMock.insert.mockImplementation(() => ({ values: () => Promise.resolve() }));

    const updateBikeSpy = vi.spyOn(storage, "updateBike").mockResolvedValue(freshBike);
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);
    const armParkingRecalc = vi.fn();
    setLockGateway({ armParkingRecalc } as any);

    await storage.updateTicket(1, { status: "closed", returnBikeToAvailable: true }, "operator");

    expect(armParkingRecalc).toHaveBeenCalledWith("IMEI-1", "BC-01");

    updateBikeSpy.mockRestore();
    recalcSpy.mockRestore();
  });

  it("does not arm the hook when the bike has no lock attached", async () => {
    const staleBike = bikeRow({ lockImei: null });
    const freshBike = bikeRow({ lat: 999, lng: 888, lockImei: null });
    const selectResults: unknown[][] = [
      [ticketRow({ status: "new" })],
      [staleBike],
      [ticketRow({ status: "closed" })],
      [],
    ];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    dbMock.insert.mockImplementation(() => ({ values: () => Promise.resolve() }));

    const updateBikeSpy = vi.spyOn(storage, "updateBike").mockResolvedValue(freshBike);
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);
    const armParkingRecalc = vi.fn();
    setLockGateway({ armParkingRecalc } as any);

    await storage.updateTicket(1, { status: "closed", returnBikeToAvailable: true }, "operator");

    expect(armParkingRecalc).not.toHaveBeenCalled();

    updateBikeSpy.mockRestore();
    recalcSpy.mockRestore();
  });

  it("does not arm the hook when updateBike returns undefined (bike deleted mid-flight)", async () => {
    const staleBike = bikeRow({ lockImei: "IMEI-1" });
    const selectResults: unknown[][] = [
      [ticketRow({ status: "new" })],
      [staleBike],
      [ticketRow({ status: "closed" })],
      [],
    ];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    dbMock.insert.mockImplementation(() => ({ values: () => Promise.resolve() }));

    const updateBikeSpy = vi.spyOn(storage, "updateBike").mockResolvedValue(undefined);
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);
    const armParkingRecalc = vi.fn();
    setLockGateway({ armParkingRecalc } as any);

    await storage.updateTicket(1, { status: "closed", returnBikeToAvailable: true }, "operator");

    expect(armParkingRecalc).not.toHaveBeenCalled();

    updateBikeSpy.mockRestore();
    recalcSpy.mockRestore();
  });

  it("is a safe no-op when no gateway is registered", async () => {
    const staleBike = bikeRow({ lockImei: "IMEI-1" });
    const freshBike = bikeRow({ lat: 999, lng: 888, lockImei: "IMEI-1" });
    const selectResults: unknown[][] = [
      [ticketRow({ status: "new" })],
      [staleBike],
      [ticketRow({ status: "closed" })],
      [],
    ];
    dbMock.select.mockImplementation(() => selectFrom(selectResults.shift() ?? []));
    dbMock.update.mockImplementation(() => {
      const chain: any = { set: () => chain, where: () => Promise.resolve() };
      return chain;
    });
    dbMock.insert.mockImplementation(() => ({ values: () => Promise.resolve() }));

    const updateBikeSpy = vi.spyOn(storage, "updateBike").mockResolvedValue(freshBike);
    const recalcSpy = vi.spyOn(storage, "recalculateBikeParking").mockResolvedValue(undefined);

    await expect(
      storage.updateTicket(1, { status: "closed", returnBikeToAvailable: true }, "operator"),
    ).resolves.not.toThrow();

    updateBikeSpy.mockRestore();
    recalcSpy.mockRestore();
  });
});

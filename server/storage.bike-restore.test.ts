import { beforeEach, describe, expect, it, vi } from "vitest";

// restoreBike undoes archiveBike: it must refuse a missing bike, refuse a
// bike that isn't currently archived, and otherwise flip status to
// "offline" (never straight to "available" — see the comment on
// restoreBike in server/storage/bike.ts for why).

const dbMock = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));

vi.mock("./db/bootstrap", () => ({ db: dbMock, pool: {}, bootstrapReady: Promise.resolve() }));

import { DatabaseStorage } from "./storage";

function mockGetBike(bike: Record<string, unknown> | undefined) {
  dbMock.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(bike ? [bike] : []) }) }),
  });
}

function mockUpdate() {
  const sets: unknown[] = [];
  dbMock.update.mockReturnValue({
    set: (patch: unknown) => {
      sets.push(patch);
      return { where: () => Promise.resolve() };
    },
  });
  return sets;
}

const ARCHIVED_BIKE = { id: "bike-1", status: "archived", lockImei: null };
const OFFLINE_BIKE = { id: "bike-1", status: "offline", lockImei: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DatabaseStorage.restoreBike", () => {
  it("refuses a bike that doesn't exist", async () => {
    mockGetBike(undefined);

    const result = await new DatabaseStorage().restoreBike("ghost");

    expect(result).toEqual({ error: "Велосипед не найден" });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("refuses a bike that isn't archived", async () => {
    mockGetBike({ id: "bike-1", status: "available", lockImei: null });

    const result = await new DatabaseStorage().restoreBike("bike-1");

    expect(result).toEqual({ error: "Велосипед не в архиве" });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("flips an archived bike to offline, not available", async () => {
    let call = 0;
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([call++ === 0 ? ARCHIVED_BIKE : OFFLINE_BIKE]),
        }),
      }),
    }));
    const sets = mockUpdate();

    const result = await new DatabaseStorage().restoreBike("bike-1");

    expect(sets).toEqual([{ status: "offline" }]);
    expect(result).toEqual({ bike: OFFLINE_BIKE });
  });
});

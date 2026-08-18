// Tests for createParking()'s allocation-race fix (audit: слой данных,
// "nextParkingId() — полный scan и гонка"). Drizzle is mocked, so this
// exercises the TS-side contract: an explicit id conflict is translated to a
// friendly domain error, and an auto-generated P-NN candidate that collides
// with a just-inserted row (simulating a concurrent create) retries with the
// next free slot instead of failing or double-allocating.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Parking } from "@shared/schema";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn() }));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));

import { storage } from "./storage";

const UNIQUE_VIOLATION = { code: "23505" };

function parkingRow(overrides: Partial<Parking> = {}): Parking {
  return {
    id: "P-01", name: "Test", city: "Калининград", lat: 350, lng: 217,
    capacity: 10, occupied: 0, radius: 30, status: "active", notes: null,
    archivedAt: null, seed: false, createdAt: 0, updatedAt: 0,
    ...overrides,
  } as Parking;
}

const baseInput = {
  name: "Test", city: "Калининград", lat: 350, lng: 217,
  capacity: 10, occupied: 0, radius: 30, status: "active" as const,
};

/** Queue of rows for consecutive db.select() calls (nextParkingId reads + getParking). */
let selectQueue: unknown[][] = [];
/** Queue of outcomes for consecutive db.insert().values() calls. */
let insertQueue: (Error | undefined)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue = [];
  insertQueue = [];
  dbMock.select.mockImplementation(() => {
    const rows = selectQueue.shift() ?? [];
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  });
  dbMock.insert.mockImplementation(() => ({
    values: () => {
      const outcome = insertQueue.shift();
      return outcome ? Promise.reject(outcome) : Promise.resolve();
    },
  }));
});

describe("createParking — explicit id", () => {
  it("creates the parking when the code is free", async () => {
    insertQueue = [undefined];
    selectQueue = [[parkingRow({ id: "P-CUSTOM" })]]; // getParking() after insert

    const result = await storage.createParking({ ...baseInput, id: "p-custom" });

    expect(result).toEqual({ parking: parkingRow({ id: "P-CUSTOM" }) });
  });

  it("returns a friendly domain error instead of a raw 23505 on a duplicate code", async () => {
    insertQueue = [UNIQUE_VIOLATION];

    const result = await storage.createParking({ ...baseInput, id: "P-01" });

    expect(result).toEqual({ error: "Парковка с таким кодом уже существует" });
  });
});

describe("createParking — auto-generated P-NN id (race-safety)", () => {
  it("retries the next free slot when a concurrent create just took the first candidate", async () => {
    // 1st nextParkingId() scan: no parkings yet -> candidate "P-01".
    // Insert of "P-01" fails: another request won the race and took it first.
    // 2nd nextParkingId() scan now sees "P-01" taken -> candidate "P-02".
    // Insert of "P-02" succeeds. Final getParking("P-02") returns the row.
    selectQueue = [[], [{ id: "P-01" }], [parkingRow({ id: "P-02" })]];
    insertQueue = [UNIQUE_VIOLATION, undefined];

    const result = await storage.createParking({ ...baseInput });

    expect(result).toEqual({ parking: parkingRow({ id: "P-02" }) });
    expect(insertQueue).toHaveLength(0); // both insert attempts were consumed
  });

  it("allocates P-01 directly when the table is empty", async () => {
    selectQueue = [[], [parkingRow({ id: "P-01" })]];
    insertQueue = [undefined];

    const result = await storage.createParking({ ...baseInput });

    expect(result).toEqual({ parking: parkingRow({ id: "P-01" }) });
  });

  it("gives up with a domain error after exhausting retry attempts instead of looping forever", async () => {
    // Every single attempt collides — e.g. some external anomaly keeps
    // re-taking whatever candidate we pick. MAX_ATTEMPTS is 50; the scan
    // read is queued fresh each time, so provide 50 scan-reads + 50 conflicts.
    selectQueue = Array.from({ length: 50 }, () => []);
    insertQueue = Array.from({ length: 50 }, () => UNIQUE_VIOLATION);

    const result = await storage.createParking({ ...baseInput });

    expect(result).toEqual({ error: "Не удалось выделить код парковки — попробуйте ещё раз" });
  });
});

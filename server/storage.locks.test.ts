// Tests for the bike <-> smart-lock binding in the storage layer.
//
// The Drizzle client and the pg pool are mocked, so this runs without Postgres
// (audit H5). What it covers is the TypeScript-side behaviour that a live
// database would not tell us about anyway: how a unique-index violation is
// translated for the operator, and that a lock leaves the discovery table once
// it is bound to a bike.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike } from "@shared/schema";

const IMEI = "861234567890123";

/** Rows the next db.select() chain resolves to, in call order. */
let selectResults: unknown[][] = [];
/** Set to make the INSERT/UPDATE reject, standing in for a Postgres error. */
let writeError: unknown = null;

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
}));
const poolMock = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db/bootstrap", () => ({
  db: dbMock,
  pool: poolMock,
  bootstrapReady: Promise.resolve(),
}));

import { storage } from "./storage";

function bikeRow(overrides: Partial<Bike> = {}): Bike {
  return {
    id: "BC-01", model: "City", status: "available", battery: 100,
    lat: 0, lng: 0, lastSeen: 0, idleHours: 0, flagged: false,
    serial: null, lockId: null, lockImei: IMEI, lockOnline: false,
    lockLastSeen: null, parkingId: null, notes: null, seed: false,
    ...overrides,
  } as Bike;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  writeError = null;

  dbMock.select.mockImplementation(() => {
    const rows = selectResults.shift() ?? [];
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return chain;
  });
  const write = () => {
    const chain: any = {
      values: () => (writeError ? Promise.reject(writeError) : Promise.resolve()),
      set: () => chain,
      where: () => (writeError ? Promise.reject(writeError) : Promise.resolve()),
    };
    return chain;
  };
  dbMock.insert.mockImplementation(write);
  dbMock.update.mockImplementation(write);
  poolMock.query.mockResolvedValue({ rows: [] });
});

const createInput = {
  id: "BC-01", lockImei: IMEI, model: "City", status: "available" as const, battery: 100,
};

describe("createBike lock binding", () => {
  it("drops the discovery row once the lock is bound to a bike", async () => {
    selectResults = [[], [bikeRow()]];

    const result = await storage.createBike(createInput);

    expect(result).toEqual({ bike: bikeRow() });
    const deletes = poolMock.query.mock.calls.filter(([sql]) =>
      String(sql).includes("DELETE FROM unassigned_locks"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toEqual([IMEI]);
  });

  it("reports a lock taken by another bike instead of throwing", async () => {
    selectResults = [[]];
    writeError = Object.assign(new Error("duplicate key"), { code: "23505" });

    const result = await storage.createBike(createInput);

    expect(result).toEqual({ error: expect.stringContaining("другому велосипеду") });
  });

  // createBike writes through Drizzle, which does not rethrow the pg error: it
  // wraps it in a DrizzleQueryError carrying no `code` of its own, with the
  // SQLSTATE on `cause`. Confirmed against a real Postgres — matching only the
  // top-level code sent back a 500 with the raw SQL and params in the body.
  it("reports a lock taken when Drizzle wraps the pg error in `cause`", async () => {
    selectResults = [[]];
    writeError = Object.assign(new Error('Failed query: insert into "bikes"'), {
      cause: Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "idx_bikes_lock_imei",
      }),
    });

    const result = await storage.createBike(createInput);

    expect(result).toEqual({ error: expect.stringContaining("другому велосипеду") });
  });

  it("does not swallow an unrelated database failure", async () => {
    selectResults = [[]];
    writeError = Object.assign(new Error("connection terminated"), { code: "57P01" });

    await expect(storage.createBike(createInput)).rejects.toThrow("connection terminated");
  });
});

describe("adminUpdateBike lock binding", () => {
  it("leaves the lock alone when the patch does not mention it", async () => {
    selectResults = [[bikeRow()], [bikeRow()]];

    await storage.adminUpdateBike("BC-01", { model: "City+" });

    expect(poolMock.query).not.toHaveBeenCalled();
  });

  it("clears the live lock state when the lock is swapped", async () => {
    const other = "861234567890124";
    const swapped = bikeRow({ lockImei: other });
    selectResults = [[bikeRow({ lockOnline: true, lockLastSeen: 123 })], [swapped]];
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = {
        set: (v: unknown) => { setSpy(v); return chain; },
        where: () => Promise.resolve(),
      };
      return chain;
    });

    const result = await storage.adminUpdateBike("BC-01", { lockImei: other });

    expect(result).toEqual({ bike: swapped });
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ lockImei: other, lockOnline: false, lockLastSeen: null }),
    );
  });
});

describe("listUnassignedLocks", () => {
  it("filters by recency and excludes locks already fitted to a bike", async () => {
    poolMock.query.mockResolvedValue({ rows: [{ imei: IMEI, lastSeen: 42 }] });

    const rows = await storage.listUnassignedLocks(1_000);

    expect(rows).toEqual([{ imei: IMEI, lastSeen: 42 }]);
    const [sql, params] = poolMock.query.mock.calls[0];
    expect(params).toEqual([1_000]);
    // The anti-join is the whole point of the endpoint: a sighting row survives
    // assignment, so an assigned IMEI must be filtered out by the query itself.
    expect(String(sql)).toMatch(/NOT EXISTS[\s\S]*bikes[\s\S]*lock_imei/);
    expect(String(sql)).toContain("last_seen >= $1");
  });
});

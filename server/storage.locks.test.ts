// Tests for the bike <-> smart-lock binding in the storage layer.
//
// The Drizzle client and the pg pool are mocked, so this runs without Postgres
// (audit H5). What it covers is the TypeScript-side behaviour that a live
// database would not tell us about anyway: how a unique-index violation is
// translated for the operator, and that a lock leaves the discovery table once
// it is bound to a bike.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bike } from "@shared/schema";
import { unassignedLocks, locks } from "@shared/schema";

const IMEI = "861234567890123";

// drizzle's eq(column, value) queryChunks hold the column ref plus a Param
// node for the bound value; a Param is the only chunk with a non-array
// `.value`, which is what makes it distinguishable from both the raw column
// ref (no `.value`) and StringChunk (`.value` is an array).
function extractEqValue(cond: unknown): unknown {
  const chunks = (cond as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  for (const c of chunks) {
    if (c && typeof c === "object" && "value" in c && !Array.isArray((c as { value?: unknown }).value)) {
      return (c as { value: unknown }).value;
    }
  }
  return undefined;
}

/** Rows the next db.select() chain resolves to, in call order. */
let selectResults: unknown[][] = [];
/** Set to make the INSERT/UPDATE/DELETE reject, standing in for a Postgres error. */
let writeError: unknown = null;
/** db.delete(table) / db.update(table) calls, recorded with their bound where-value. */
let deleteCalls: { table: unknown; imei?: unknown }[] = [];
let updateCalls: { table: unknown; set?: unknown; imei?: unknown }[] = [];

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
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
    lockImei: IMEI, lockOnline: false,
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

  deleteCalls = [];
  updateCalls = [];
  dbMock.update.mockImplementation((table: unknown) => {
    const entry: { table: unknown; set?: unknown; imei?: unknown } = { table };
    updateCalls.push(entry);
    const chain: any = {
      set: (v: unknown) => { entry.set = v; return chain; },
      where: (cond: unknown) => {
        entry.imei = extractEqValue(cond);
        return writeError ? Promise.reject(writeError) : Promise.resolve();
      },
    };
    return chain;
  });
  dbMock.delete.mockImplementation((table: unknown) => {
    const entry: { table: unknown; imei?: unknown } = { table };
    deleteCalls.push(entry);
    return {
      where: (cond: unknown) => {
        entry.imei = extractEqValue(cond);
        return writeError ? Promise.reject(writeError) : Promise.resolve();
      },
    };
  });
  poolMock.query.mockResolvedValue({ rows: [] });
});

const createInput = {
  id: "BC-01", lockImei: IMEI, model: "City", status: "available" as const, battery: 100,
};

describe("available lock discovery", () => {
  it("returns an active unbound registry lock and excludes decommissioned locks", async () => {
    const activeUnboundLock = { imei: IMEI, lastSeen: 1_700_000_000_000 };
    poolMock.query.mockResolvedValueOnce({ rows: [activeUnboundLock] });

    const result = await storage.listUnassignedLocks();

    expect(result).toEqual([activeUnboundLock]);
    const [sql, params] = poolMock.query.mock.calls[0];
    expect(sql).toContain("FROM locks");
    expect(sql).toContain("bike_id IS NULL");
    expect(sql).toContain("status <> 'decommissioned'");
    expect(sql).not.toContain("FROM unassigned_locks");
    expect(params).toBeUndefined();
  });
});

describe("createBike lock binding", () => {
  it("drops the discovery row once the lock is bound to a bike", async () => {
    selectResults = [[], [bikeRow()]];

    const result = await storage.createBike(createInput);

    expect(result).toEqual({ bike: bikeRow() });
    const unassignedDeletes = deleteCalls.filter((d) => d.table === unassignedLocks);
    expect(unassignedDeletes).toHaveLength(1);
    expect(unassignedDeletes[0].imei).toBe(IMEI);

    const locksUpdates = updateCalls.filter((u) => u.table === locks);
    expect(locksUpdates).toHaveLength(1);
    expect(locksUpdates[0].imei).toBe(IMEI);
    expect(locksUpdates[0].set).toEqual(
      expect.objectContaining({ bikeId: "BC-01", updatedAt: expect.any(Number) }),
    );
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

    await storage.adminUpdateBike("BC-01", { notes: "x" });

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

describe("updateLock provisioning metadata", () => {
  it("persists ICCID, APN, MAC address, and firmware version", async () => {
    const existing = { id: 7, imei: IMEI };
    const patch = {
      simIccid: "8970101829255631812-9",
      apn: "cmiot",
      macAddress: "12:34:56:78:90:AB",
      firmwareVersion: "OC32_110",
    };
    selectResults = [[existing]];
    const setSpy = vi.fn();
    dbMock.update.mockImplementation(() => {
      const chain: any = {
        set: (value: unknown) => { setSpy(value); return chain; },
        where: () => chain,
        returning: () => Promise.resolve([{ ...existing, ...patch }]),
      };
      return chain;
    });

    const result = await storage.updateLock(7, patch);

    expect(result).toEqual({ lock: { ...existing, ...patch } });
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining(patch));
  });
});

describe("getActiveRideForBike (audit F-07)", () => {
  it("returns the active ride row for a bike", async () => {
    const ride = { id: 42, bikeId: "BC-01", userId: "rider-9", status: "active" };
    selectResults = [[ride]];

    const result = await storage.getActiveRideForBike("BC-01");

    expect(result).toEqual(ride);
  });

  it("returns undefined when the bike has no active ride", async () => {
    selectResults = [[]];

    const result = await storage.getActiveRideForBike("BC-01");

    expect(result).toBeUndefined();
  });
});

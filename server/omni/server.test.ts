// End-to-end tests for the OMNI lock TCP ingest server.
//
// These drive real TCP sockets: MockLock (server/omni/mockLock.ts) speaks the
// genuine wire protocol on one side, OmniTcpServer listens on an ephemeral port
// on the other, and an in-memory OmniStore stands in for Postgres so the suite
// still needs no live database (see vitest.config.ts / audit H5).
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

// server/omni/store.ts imports the shared pg pool, whose module-level
// `bootstrapReady` would try to reach Postgres on import. The tests inject a
// fake store instead, so nothing here ever touches the real pool.
vi.mock("../db/bootstrap", () => ({
  pool: { query: async () => ({ rows: [] }) },
  db: {},
  bootstrapReady: Promise.resolve(),
}));

import { OmniTcpServer, type OmniServerOptions } from "./server";
import { MockLock } from "./mockLock";
import { TelemetryWriter, type BikeLiveUpdate, type LockAuthResult, type OmniStore, type TelemetryRow } from "./store";
import type { OmniMessage } from "@shared/omni/protocol";

const IMEI_A = "861234567890123";
const IMEI_B = "861234567890124";
const IMEI_C = "861234567890125";
const UNKNOWN_IMEI = "869999999999999";
const DECOMMISSIONED_IMEI = "861234567890199";

class FakeStore implements OmniStore {
  /** Pre-provisioned device registry — mirrors the admin-created `locks` table.
   *  Only IMEIs present here are ever authorized (audit F-01/F-03/F-09);
   *  UNKNOWN_IMEI is deliberately absent to exercise the fail-closed path. */
  readonly registry = new Map<string, { bikeId: string | null; status: string }>([
    [IMEI_A, { bikeId: "bike-a", status: "active" }],
    [IMEI_B, { bikeId: "bike-b", status: "active" }],
    [IMEI_C, { bikeId: "bike-c", status: "active" }],
    [DECOMMISSIONED_IMEI, { bikeId: "bike-old", status: "decommissioned" }],
  ]);
  readonly telemetry: TelemetryRow[] = [];
  readonly live: BikeLiveUpdate[] = [];
  readonly onlineCalls: { imei: string; online: boolean }[] = [];
  readonly offlineSweeps: number[] = [];
  readonly locks = new Map<string, Record<string, unknown>>();
  resetCount = 0;
  /** Set to make resolveLock/findBikeIdByImei throw, simulating a database outage. */
  lookupError: Error | null = null;
  /** Set to stall resolveLock/findBikeIdByImei, so a test can act during the lookup. */
  lookupGate: Promise<void> | null = null;
  /** Sightings of locks not fitted to a bike, keyed by IMEI. */
  readonly sightings = new Map<string, { firstSeen: number; lastSeen: number }>();
  /** Set to make recordUnassignedLock throw, simulating a database outage. */
  sightingError: Error | null = null;

  async findBikeIdByImei(imei: string): Promise<string | null> {
    if (this.lookupGate) await this.lookupGate;
    if (this.lookupError) throw this.lookupError;
    return this.registry.get(imei)?.bikeId ?? null;
  }

  /** Fail-closed registry lookup — mirrors PgOmniStore.resolveLock: never
   *  creates a row, rejects anything not pre-provisioned or decommissioned. */
  async resolveLock(imei: string): Promise<LockAuthResult> {
    if (this.lookupGate) await this.lookupGate;
    if (this.lookupError) throw this.lookupError;
    const row = this.registry.get(imei);
    if (!row) return { authorized: false, reason: "unknown" };
    if (row.status === "decommissioned") return { authorized: false, reason: "decommissioned" };
    return { authorized: true, bikeId: row.bikeId };
  }

  async recordUnassignedLock(imei: string, at: number): Promise<void> {
    if (this.sightingError) throw this.sightingError;
    const prev = this.sightings.get(imei);
    this.sightings.set(imei, { firstSeen: prev?.firstSeen ?? at, lastSeen: at });
  }

  async insertTelemetry(rows: TelemetryRow[]): Promise<void> {
    this.telemetry.push(...rows);
  }

  async applyLiveUpdates(updates: BikeLiveUpdate[]): Promise<void> {
    this.live.push(...updates);
  }

  async setLockOnline(imei: string, online: boolean): Promise<void> {
    this.onlineCalls.push({ imei, online });
  }

  async resetAllLocksOffline(): Promise<void> {
    this.resetCount++;
  }

  async markLocksOfflineBefore(before: number): Promise<void> {
    this.offlineSweeps.push(before);
  }

  async persistLockReport(imei: string, message: OmniMessage, at: number): Promise<void> {
    const row = this.locks.get(imei) ?? {};
    Object.assign(row, { status: "active", lastSeenAt: at });
    switch (message.type) {
      case "checkin": Object.assign(row, { lastBatteryVoltage: message.voltageCv / 100 }); break;
      case "heartbeat": Object.assign(row, {
        lastLockState: message.locked ? "locked" : "unlocked",
        lastBatteryVoltage: message.voltageCv / 100,
        lastSignalStrength: message.signal,
      }); break;
      case "position":
        if (message.fix) Object.assign(row, { lastLatitude: message.fix.lat, lastLongitude: message.fix.lng, lastLocationAt: at });
        break;
      case "alarm": Object.assign(row, {
        lastAlarmType: ({ 1: "illegal_movement", 2: "fall", 6: "fall_cleared" } as Record<number, string>)[message.code] ?? String(message.code),
        lastAlarmAt: at,
      }); break;
      case "lockReport": Object.assign(row, { lastLockState: "locked" }); break;
      case "firmware": Object.assign(row, { firmwareVersion: message.firmwareVersion, deviceTypeCode: message.deviceTypeCode }); break;
      case "iccid": Object.assign(row, { simIccid: message.simIccid }); break;
      case "mac": Object.assign(row, { macAddress: message.macAddress }); break;
    }
    this.locks.set(imei, row);
  }

  rowsFor(cmd: string): TelemetryRow[] {
    return this.telemetry.filter((r) => r.cmd === cmd);
  }
}

const silentLogger = pino({ level: "silent" });

/** Poll until `predicate` holds, so tests never depend on a fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  server: OmniTcpServer;
  store: FakeStore;
  lock(imei: string): Promise<MockLock>;
}

const active: { servers: OmniTcpServer[]; locks: MockLock[] } = { servers: [], locks: [] };

type Overrides = Partial<Omit<OmniServerOptions, "store" | "logger">>;

async function harness(overrides: Overrides = {}): Promise<Harness> {
  const store = new FakeStore();
  const server = new OmniTcpServer({
    store,
    logger: silentLogger,
    port: 0,
    host: "127.0.0.1",
    // Flush fast so assertions do not wait on the 2 s production window, and
    // disable status throttling unless a test opts into it.
    writer: { flushIntervalMs: 5 },
    statusMinIntervalMs: 0,
    ...overrides,
  });
  await server.listen();
  active.servers.push(server);

  return {
    server,
    store,
    async lock(imei: string) {
      const lock = new MockLock({ imei, port: server.port, host: "127.0.0.1" });
      await lock.connect();
      active.locks.push(lock);
      return lock;
    },
  };
}

afterEach(async () => {
  for (const lock of active.locks.splice(0)) lock.disconnect();
  for (const server of active.servers.splice(0)) await server.close();
});

describe("connection lifecycle", () => {
  it("clears stale online flags before accepting anything", async () => {
    const { store } = await harness();
    expect(store.resetCount).toBe(1);
  });

  it("binds a lock on its first valid packet and marks it online", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendCheckin(412);

    await waitFor(() => store.onlineCalls.length > 0);
    expect(store.onlineCalls[0]).toEqual({ imei: IMEI_A, online: true });
    expect(server.connectionCount).toBe(1);
  });

  it("marks a lock offline when the socket closes", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    device.disconnect();

    await waitFor(() => store.onlineCalls.length === 2);
    expect(store.onlineCalls[1]).toEqual({ imei: IMEI_A, online: false });
  });

  it("closes the stale socket when a device reconnects with the same IMEI", async () => {
    const { server, store, lock } = await harness();
    const first = await lock(IMEI_A);
    first.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    const second = await lock(IMEI_A);
    second.sendCheckin();

    // The replacement owns the registry slot and the stale socket is gone, so
    // the device is left online rather than being marked offline by the
    // teardown of the socket it just replaced.
    await waitFor(() => server.connectionCount === 1);
    expect(store.onlineCalls.filter((c) => c.online === false)).toEqual([]);

    // The surviving socket still ingests: the second check-in landed.
    await waitFor(() => store.rowsFor("Q0").length >= 2);
  });

  it("rejects an unregistered IMEI without persisting anything", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(UNKNOWN_IMEI);

    device.sendCheckin();

    await waitFor(() => server.connectionCount === 0);
    expect(store.onlineCalls).toEqual([]);
    expect(store.telemetry).toEqual([]);
  });

  it("does not re-query the database for a rejected IMEI on every reconnect", async () => {
    const { server, store, lock } = await harness();
    const spy = vi.spyOn(store, "resolveLock");

    for (let i = 0; i < 3; i++) {
      const device = await lock(UNKNOWN_IMEI);
      device.sendCheckin();
      await waitFor(() => server.connectionCount === 0);
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects a decommissioned IMEI without persisting anything", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(DECOMMISSIONED_IMEI);

    device.sendCheckin();

    await waitFor(() => server.connectionCount === 0);
    expect(store.onlineCalls).toEqual([]);
    expect(store.telemetry).toEqual([]);
  });

  it("does not treat a decommissioned IMEI as a discoverable sighting", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(DECOMMISSIONED_IMEI);

    device.sendCheckin();

    await waitFor(() => server.connectionCount === 0);
    // Decommissioning is a deliberate admin action, not an unknown device —
    // it must never resurface in the unassigned-locks discovery list.
    expect(store.sightings.has(DECOMMISSIONED_IMEI)).toBe(false);
  });

  // Audit F-09 residual gap: bind() already fail-closes NEW connections for a
  // decommissioned IMEI, but a socket that authenticated *before* the
  // decommission previously stayed live — revokeImei() is what
  // DELETE/PATCH /api/admin/locks now calls to close that gap.
  it("disconnects an already-connected lock the moment it is decommissioned (audit F-09)", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);
    expect(server.connectionCount).toBe(1);

    // Simulate the admin action: the registry row flips to decommissioned...
    store.registry.set(IMEI_A, { bikeId: "bike-a", status: "decommissioned" });
    // ...and the HTTP handler tells the gateway to cut the live socket off.
    server.revokeImei(IMEI_A);

    await waitFor(() => server.connectionCount === 0);
    expect(store.onlineCalls.at(-1)).toEqual({ imei: IMEI_A, online: false });

    // Defense in depth: with the socket gone, an unlock command can no
    // longer be delivered to this device under any circumstances.
    await expect(server.sendUnlockCommand(IMEI_A, "1234")).rejects.toThrow(
      /not connected/,
    );
  });

  it("does not let a decommissioned lock reconnect within the auth cache TTL (audit F-09)", async () => {
    const { server, store, lock } = await harness();
    const resolveLockSpy = vi.spyOn(store, "resolveLock");

    const first = await lock(IMEI_A);
    first.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);
    expect(resolveLockSpy).toHaveBeenCalledTimes(1);

    // Decommission while the cache still holds a fresh positive result for
    // this IMEI (well inside the 60s TTL). Without evicting the cache entry,
    // a reconnect here would be waved through from cache without ever
    // re-checking the (now decommissioned) registry row.
    store.registry.set(IMEI_A, { bikeId: "bike-a", status: "decommissioned" });
    server.revokeImei(IMEI_A);
    await waitFor(() => server.connectionCount === 0);

    const second = await lock(IMEI_A);
    second.sendCheckin();

    await waitFor(() => resolveLockSpy.mock.calls.length === 2);
    expect(server.connectionCount).toBe(0);
    expect(store.onlineCalls.filter((c) => c.online === true)).toHaveLength(1);
  });

  it("records a sighting of an unregistered lock so it can be assigned later", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(UNKNOWN_IMEI);

    device.sendCheckin();

    await waitFor(() => store.sightings.has(UNKNOWN_IMEI));
    // Discovery must not grant access: the socket still goes and nothing is stored.
    await waitFor(() => server.connectionCount === 0);
    expect(store.telemetry).toEqual([]);
    expect(store.onlineCalls).toEqual([]);
  });

  it("does not record a sighting for a lock that is already fitted to a bike", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendCheckin();

    await waitFor(() => store.onlineCalls.length === 1);
    expect(store.sightings.size).toBe(0);
  });

  it("throttles sighting writes through the negative IMEI cache", async () => {
    const { server, store, lock } = await harness();
    const spy = vi.spyOn(store, "recordUnassignedLock");

    // A rejected lock reconnects immediately and forever; the sighting write
    // must not follow it, or the lock port becomes a write amplifier.
    for (let i = 0; i < 3; i++) {
      const device = await lock(UNKNOWN_IMEI);
      device.sendCheckin();
      await waitFor(() => server.connectionCount === 0);
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("still rejects an unregistered lock when the sighting write fails", async () => {
    const { server, store, lock } = await harness();
    store.sightingError = new Error("db down");
    const device = await lock(UNKNOWN_IMEI);

    device.sendCheckin();

    await waitFor(() => server.connectionCount === 0);
    expect(store.telemetry).toEqual([]);
  });

  it("closes a socket that changes IMEI mid-session", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    device.sendRaw(device.packet("Q0", [400]).toString("latin1").replace(IMEI_A, IMEI_B));

    await waitFor(() => server.connectionCount === 0);
    expect(store.telemetry.every((r) => r.imei === IMEI_A)).toBe(true);
  });

  it("refuses connections beyond the configured cap", async () => {
    const { server, store, lock } = await harness({ maxConnections: 1 });
    const first = await lock(IMEI_A);
    first.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    const second = await lock(IMEI_B);
    // The listener destroys the socket at accept time, before any packet is read.
    await waitFor(() => server.connectionCount === 1);
    expect(() => second.sendCheckin()).not.toThrow();
    await waitFor(() => store.rowsFor("Q0").length === 1);
    expect(store.onlineCalls).toEqual([{ imei: IMEI_A, online: true }]);
  });

  it("refuses new connections from a source IP that exceeds the rate limit (audit F-05)", async () => {
    // All MockLock instances dial in from 127.0.0.1, so a tight limit here
    // exercises the per-source-IP bucket without waiting out the window.
    const { server, store, lock } = await harness({ maxNewConnectionsPerIp: 2, newConnectionWindowMs: 60_000 });

    const first = await lock(IMEI_A);
    first.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    const second = await lock(IMEI_B);
    second.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 2);

    // Third connection attempt from the same IP within the window is over the
    // cap: the listener must destroy it at accept time, before any IMEI lookup.
    const third = await lock(IMEI_C);
    expect(() => third.sendCheckin()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.connectionCount).toBe(2);
    expect(store.onlineCalls).toEqual([
      { imei: IMEI_A, online: true },
      { imei: IMEI_B, online: true },
    ]);
  });

  it("closes a connection that sustains a frame rate above the configured limit (audit F-06)", async () => {
    const { server, store, lock } = await harness({ maxFramesPerSecond: 2, frameBucketCapacity: 3 });
    const device = await lock(IMEI_A);

    // Burst well past the 3-token bucket in one tight loop — no meaningful
    // time passes between iterations, so refill is negligible.
    for (let i = 0; i < 6; i++) device.sendCheckin();

    await waitFor(() => server.connectionCount === 0);
    // Only the frames spent from the initial burst budget before the limiter
    // tripped and destroyed the socket were ever persisted.
    expect(store.rowsFor("Q0").length).toBeLessThanOrEqual(3);
  });

  it("does not register a socket that closed while its IMEI was being looked up", async () => {
    const { server, store, lock } = await harness();
    let openGate = () => {};
    store.lookupGate = new Promise<void>((resolve) => { openGate = resolve; });

    const device = await lock(IMEI_A);
    device.sendCheckin();
    // The lock hangs up mid-lookup — a real possibility on a flaky mobile link.
    await waitFor(() => server.connectionCount === 1);
    device.disconnect();
    await waitFor(() => server.connectionCount === 0);

    openGate();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A dead socket must not end up owning the registry slot: nothing would ever
    // evict it, the bike would read online forever, and sendToDevice would
    // silently write into a destroyed socket.
    expect(server.connectionCount).toBe(0);
    expect(store.onlineCalls).toEqual([]);
    expect(server.sendToDevice(IMEI_A, "S5")).toBe(false);
  });

  it("drops a socket whose IMEI cannot be resolved because the database is down", async () => {
    const { server, store, lock } = await harness();
    store.lookupError = new Error("connection refused");
    const device = await lock(IMEI_A);

    device.sendCheckin();

    await waitFor(() => server.connectionCount === 0);
    expect(store.onlineCalls).toEqual([]);
  });
});

describe("stream framing over a real socket", () => {
  it("ingests two packets coalesced into a single write", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendRaw(Buffer.concat([
      device.packet("Q0", [412]),
      device.packet("H0", [1, 405, 24]),
    ]));

    await waitFor(() => store.rowsFor("Q0").length === 1 && store.rowsFor("H0").length === 1);
    expect(store.rowsFor("H0")[0].signalLevel).toBe(24);
  });

  it("reassembles a packet delivered one byte per write", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);
    const packet = device.packet("Q0", [377]);

    for (const byte of packet) {
      device.sendRaw(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }

    await waitFor(() => store.rowsFor("Q0").length === 1);
    expect(store.rowsFor("Q0")[0].voltageCv).toBe(377);
  });

  it("handles a write boundary in the middle of a packet", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);
    const packet = device.packet("H0", [0, 390, 19]);
    const cut = 20;

    device.sendRaw(packet.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 20));
    device.sendRaw(packet.subarray(cut));

    await waitFor(() => store.rowsFor("H0").length === 1);
    expect(store.rowsFor("H0")[0].locked).toBe(false);
  });

  it("keeps the connection alive across a malformed frame", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.rowsFor("Q0").length === 1);

    // Structurally broken (bad manufacturer) and semantically broken (voltage
    // out of the documented 320-420 range) frames are both logged and skipped.
    device.sendRaw(`*CMDR,ZZ,${IMEI_A},200318123020,Q0,412#\n`);
    device.sendRaw(device.packet("Q0", [9999]));
    device.sendCheckin(400);

    await waitFor(() => store.rowsFor("Q0").length === 2);
    expect(server.connectionCount).toBe(1);
    expect(store.rowsFor("Q0").map((r) => r.voltageCv)).toEqual([412, 400]);
  });

  it("closes a connection that never terminates a frame", async () => {
    const { server, store, lock } = await harness({ maxFrameBytes: 256 });
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    device.sendRaw(`*${"A".repeat(1024)}`);

    await waitFor(() => server.connectionCount === 0);
  });

  it("closes a socket that never sends a valid packet", async () => {
    const { server, lock } = await harness({ handshakeTimeoutMs: 50 });
    const device = await lock(IMEI_A);
    device.sendRaw("not a packet at all");

    await waitFor(() => server.connectionCount === 0);
  });
});

describe("acknowledgements", () => {
  it("acknowledges the commands the protocol requires a response for", async () => {
    const { lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendPosition(54.9442, 20.1561);
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["D0"] });

    device.sendAlarm(1);
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["W0"] });

    device.sendRaw(device.packet("L0", [0, "1234", 1497689816]));
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["L0"] });
  });

  it("stays silent for check-ins and heartbeats, which need no response", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendCheckin();
    device.sendHeartbeat();
    await waitFor(() => store.rowsFor("H0").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(device.received).toEqual([]);
  });

  it("pushes a server-initiated command to a connected lock", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    expect(server.sendToDevice(IMEI_A, "S5")).toBe(true);
    expect(await device.nextCommand()).toEqual({ cmd: "S5", params: [] });

    expect(server.sendToDevice(IMEI_A, "L0", [1, "1234", 1497689816])).toBe(true);
    expect(await device.nextCommand()).toEqual({ cmd: "L0", params: ["1", "1234", "1497689816"] });

    expect(server.sendToDevice(IMEI_B, "S5")).toBe(false);
  });
});

describe("Phase 2 lock registry projection", () => {
  it("runs a ten-minute stale-presence sweep in the background", async () => {
    const { store } = await harness({ offlineAfterMs: 10 * 60_000, offlineSweepIntervalMs: 5 });
    await waitFor(() => store.offlineSweeps.length > 0);
    expect(Date.now() - store.offlineSweeps[0]).toBeGreaterThanOrEqual(10 * 60_000 - 50);
  });

  it("updates lock metadata, GPS fields, and sends required acknowledgements from real TCP frames", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin(401);
    device.sendHeartbeat(false, 400, 27);
    device.sendPosition(54.7104, 20.4522);
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["D0"] });
    device.sendAlarm(1);
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["W0"] });
    device.sendRaw(device.packet("G0", ["OC32_V2.0.7", "Aug 3 2024"]));
    device.sendRaw(device.packet("I0", ["8986001234567890123"]));
    device.sendRaw(device.packet("M0", ["12:34:56:78:90:AB"]));
    device.sendRaw(device.packet("L1", ["7", "1710000000", "3"]));
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["L1"] });

    await waitFor(() => store.locks.get(IMEI_A)?.lastLockState === "locked");
    expect(store.locks.get(IMEI_A)).toMatchObject({
      status: "active", lastBatteryVoltage: 4, lastSignalStrength: 27,
      lastLatitude: 54.7104, lastLongitude: 20.4522, lastAlarmType: "illegal_movement",
      firmwareVersion: "V2.0.7", deviceTypeCode: "OC32",
      simIccid: "8986001234567890123", macAddress: "12:34:56:78:90:AB",
    });
  });

  it("correlates an L0 response with the outbound unlock request", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);
    const unlock = server.sendUnlockCommand(IMEI_A, "1234");
    const command = await device.nextCommand();
    expect(command.cmd).toBe("L0");
    expect(command.params.slice(0, 2)).toEqual(["0", "1234"]);
    device.sendRaw(device.packet("L0", [0, command.params[1], command.params[2]]));
    expect(await unlock).toEqual({ success: true });
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["L0"] });
  });

  it("refuses a second unlock command for the same lock while one is already pending (audit F-07)", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    // Two different user/second tuples targeting the same IMEI — the old
    // key (imei+user+second) would treat these as unrelated and let both
    // race the lock. The mutex must reject the second immediately.
    const first = server.sendUnlockCommand(IMEI_A, "1234");
    await expect(server.sendUnlockCommand(IMEI_A, "5678")).rejects.toThrow(
      /already pending/,
    );

    const command = await device.nextCommand();
    device.sendRaw(device.packet("L0", [0, command.params[1], command.params[2]]));
    expect(await first).toEqual({ success: true });
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["L0"] });

    // Once the first command settles, the lock is free again.
    const second = server.sendUnlockCommand(IMEI_A, "5678");
    const command2 = await device.nextCommand();
    device.sendRaw(device.packet("L0", [0, command2.params[1], command2.params[2]]));
    expect(await second).toEqual({ success: true });
  });

  it("resolves an unlock even when the lock echoes a different user/timestamp than sent (2026-08-22 production incident)", async () => {
    // The L0 handshake's (user, second) echo was only ever *specified*, never
    // empirically confirmed against real hardware the way D1 was. A real
    // rider hit exactly this: every unlock attempt timed out because the
    // physical lock's echo didn't reproduce our exact values. Matching is now
    // by IMEI alone (the F-07 mutex already guarantees single-flight per
    // lock), so a loose/mismatched echo must still resolve correctly.
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    const unlock = server.sendUnlockCommand(IMEI_A, "1234");
    const command = await device.nextCommand();
    expect(command.cmd).toBe("L0");
    // Deliberately echo a DIFFERENT user id and timestamp than we sent.
    device.sendRaw(device.packet("L0", [0, "9999", 1000000000]));
    expect(await unlock).toEqual({ success: true });
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["L0"] });
  });

  it("reports a failed unlock (result=1) even with a mismatched echo", async () => {
    const { server, store, lock } = await harness();
    const device = await lock(IMEI_A);
    device.sendCheckin();
    await waitFor(() => store.onlineCalls.length === 1);

    const unlock = server.sendUnlockCommand(IMEI_A, "1234");
    await device.nextCommand();
    device.sendRaw(device.packet("L0", [1, "0", 0]));
    expect(await unlock).toEqual({ success: false });
  });
});

describe("telemetry persistence", () => {
  it("stores a check-in with the interpolated battery percentage", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendCheckin(412);

    await waitFor(() => store.rowsFor("Q0").length === 1);
    const row = store.rowsFor("Q0")[0];
    expect(row.bikeId).toBe("bike-a");
    expect(row.imei).toBe(IMEI_A);
    expect(row.voltageCv).toBe(412);
    expect(row.batteryPct).toBe(100);
    expect(row.x).toBeNull();
    expect(row.lat).toBeNull();
    expect(store.live.some((u) => u.bikeId === "bike-a" && u.batteryPct === 100)).toBe(true);
  });

  it("stores a position report as both WGS84 and projected map coordinates", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);
    // The wire format carries whole seconds, and the server only trusts a GPS
    // clock close to now, so use a recent second-aligned instant.
    const at = Math.floor((Date.now() - 60_000) / 1000) * 1000;

    device.sendPosition(54.9442, 20.1561, { satellites: 9, at });

    await waitFor(() => store.rowsFor("D0").length === 1);
    const row = store.rowsFor("D0")[0];
    expect(row.lat).toBeCloseTo(54.9442, 4);
    expect(row.lng).toBeCloseTo(20.1561, 4);
    expect(row.x).not.toBeNull();
    expect(row.y).not.toBeNull();
    expect(row.satellites).toBe(9);
    expect(row.t).toBe(at);
    expect(store.live.some((u) => u.bikeId === "bike-a" && u.x === row.x && u.y === row.y)).toBe(true);
  });

  it("ignores an implausible GPS clock and timestamps the row on arrival", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);
    const before = Date.now();

    // A lock that has not acquired a date yet reports one years in the past.
    device.sendPosition(54.9442, 20.1561, { at: Date.UTC(2011, 0, 1) });

    await waitFor(() => store.rowsFor("D0").length === 1);
    expect(store.rowsFor("D0")[0].t).toBeGreaterThanOrEqual(before);
  });

  it("keeps a positionless report but leaves it unplottable", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendNoFix();

    await waitFor(() => store.rowsFor("D0").length === 1);
    const row = store.rowsFor("D0")[0];
    expect(row.x).toBeNull();
    expect(row.lat).toBeNull();
  });

  it("stores an alarm code", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendAlarm(2);

    await waitFor(() => store.rowsFor("W0").length === 1);
    expect(store.rowsFor("W0")[0].alarmCode).toBe(2);
  });

  it("does not store rental lifecycle or auxiliary commands as telemetry", async () => {
    const { store, lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendRaw(device.packet("L1", ["1234", 1497689816, 3]));
    device.sendRaw(device.packet("G0", ["XX_110", "Jul 4 2018"]));
    device.sendCheckin();

    await waitFor(() => store.rowsFor("Q0").length === 1);
    expect(store.telemetry.map((r) => r.cmd)).toEqual(["Q0"]);
  });

  it("throttles positionless status chatter but never drops a position", async () => {
    const { store, lock } = await harness({ statusMinIntervalMs: 60_000 });
    const device = await lock(IMEI_A);

    device.sendCheckin(412);
    device.sendHeartbeat(true, 411, 24);
    device.sendCheckin(410);
    device.sendPosition(54.9442, 20.1561);
    device.sendPosition(54.9443, 20.1562);

    await waitFor(() => store.rowsFor("D0").length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.telemetry.filter((r) => r.cmd === "Q0" || r.cmd === "H0")).toHaveLength(1);
  });

  it("throttles per bike, so one chatty lock cannot silence another", async () => {
    const { store, lock } = await harness({ statusMinIntervalMs: 60_000 });
    const a = await lock(IMEI_A);
    const b = await lock(IMEI_B);

    a.sendCheckin();
    a.sendCheckin();
    b.sendCheckin();

    await waitFor(() => store.rowsFor("Q0").length === 2);
    expect(store.rowsFor("Q0").map((r) => r.bikeId).sort()).toEqual(["bike-a", "bike-b"]);
  });

  it("batches a burst of reports into few store round-trips", async () => {
    const { store, lock } = await harness({ writer: { flushIntervalMs: 30 } });
    const device = await lock(IMEI_A);
    const insert = vi.spyOn(store, "insertTelemetry");

    for (let i = 0; i < 20; i++) device.sendPosition(54.9442 + i / 10_000, 20.1561);

    await waitFor(() => store.rowsFor("D0").length === 20);
    expect(insert.mock.calls.length).toBeLessThan(20);
  });

  it("does not lose rows queued while a slow flush is already in flight", async () => {
    // Directly against the writer: a flush snapshots the queue, so rows arriving
    // during a slow INSERT belong to the next batch and close() must drain them.
    const store = new FakeStore();
    let releaseInsert = () => {};
    const firstInsert = new Promise<void>((resolve) => { releaseInsert = resolve; });
    let calls = 0;
    vi.spyOn(store, "insertTelemetry").mockImplementation(async (rows) => {
      if (++calls === 1) await firstInsert;
      store.telemetry.push(...rows);
    });

    const writer = new TelemetryWriter(store, { flushIntervalMs: 5 });
    const row = (t: number): TelemetryRow => ({
      bikeId: "bike-a", imei: IMEI_A, cmd: "D0", t,
      x: 1, y: 2, lat: 54.9, lng: 20.1,
      satellites: 9, hdop: 1, altitudeM: 10,
      voltageCv: null, batteryPct: null, signalLevel: null, locked: null, alarmCode: null,
    });

    writer.add(row(1));
    await waitFor(() => calls === 1);
    writer.add(row(2));

    const closed = writer.close();
    releaseInsert();
    await closed;

    expect(store.telemetry.map((r) => r.t)).toEqual([1, 2]);
  });

  it("flushes buffered telemetry on shutdown", async () => {
    const { server, store, lock } = await harness({ writer: { flushIntervalMs: 60_000 } });
    const device = await lock(IMEI_A);
    device.sendPosition(54.9442, 20.1561);
    await waitFor(() => server.connectionCount === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.telemetry).toEqual([]);

    await server.close();
    active.servers.length = 0;

    expect(store.rowsFor("D0")).toHaveLength(1);
  });
});

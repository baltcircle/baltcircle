// End-to-end coverage for requestGpsRefresh() (server/omni/server.ts): the
// opportunistic burst-tracking command armed on a bike status change (see
// server/http/catalog.ts's PATCH /api/admin/bikes/:id).
//
// Drives real TCP sockets exactly like server.test.ts — see that file's
// header for the rationale. Kept in its own file (rather than appended to
// server.test.ts) because it exercises a distinct, self-contained feature
// with its own fake store needs.
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

vi.mock("../db/bootstrap", () => ({
  pool: { query: async () => ({ rows: [] }) },
  db: {},
  bootstrapReady: Promise.resolve(),
}));

import { OmniTcpServer, type OmniServerOptions } from "./server";
import { MockLock } from "./mockLock";
import type { BikeLiveUpdate, LockAuthResult, OmniStore, TelemetryRow } from "./store";
import type { OmniMessage } from "@shared/omni/protocol";

const IMEI_A = "861234567890123";
const IMEI_B = "861234567890124";

class FakeStore implements OmniStore {
  readonly registry = new Map<string, { bikeId: string | null; status: string }>([
    [IMEI_A, { bikeId: "bike-a", status: "active" }],
    [IMEI_B, { bikeId: "bike-b", status: "active" }],
  ]);
  readonly telemetry: TelemetryRow[] = [];
  readonly live: BikeLiveUpdate[] = [];
  readonly onlineCalls: { imei: string; online: boolean }[] = [];

  async findBikeIdByImei(imei: string): Promise<string | null> {
    return this.registry.get(imei)?.bikeId ?? null;
  }
  async resolveLock(imei: string): Promise<LockAuthResult> {
    const row = this.registry.get(imei);
    if (!row) return { authorized: false, reason: "unknown" };
    return { authorized: true, bikeId: row.bikeId };
  }
  async recordUnassignedLock(): Promise<void> {}
  async insertTelemetry(rows: TelemetryRow[]): Promise<void> { this.telemetry.push(...rows); }
  async applyLiveUpdates(updates: BikeLiveUpdate[]): Promise<void> { this.live.push(...updates); }
  async setLockOnline(imei: string, online: boolean): Promise<void> { this.onlineCalls.push({ imei, online }); }
  async resetAllLocksOffline(): Promise<void> {}
  async markLocksOfflineBefore(): Promise<void> {}
  // No-op: irrelevant to requestGpsRefresh's own behaviour, and the real
  // gps-refresh-registry integration is already covered by
  // store.gps-refresh.test.ts against the production PgOmniStore.
  async persistLockReport(_imei: string, _message: OmniMessage, _at: number): Promise<void> {}
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
  /** Connects and completes the handshake (checkin) — matches how a real lock registers into byImei before it can be commanded. */
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
      const l = new MockLock({ imei, port: server.port, host: "127.0.0.1" });
      await l.connect();
      active.locks.push(l);
      // Register into byImei via the same handshake a real lock performs —
      // requestGpsRefresh is a no-op until the socket is bound to this IMEI.
      l.sendCheckin();
      await waitFor(() => store.onlineCalls.some((c) => c.imei === imei && c.online));
      return l;
    },
  };
}

afterEach(async () => {
  for (const lock of active.locks.splice(0)) lock.disconnect();
  for (const server of active.servers.splice(0)) await server.close();
});

describe("requestGpsRefresh", () => {
  it("sends a D1 burst-tracking command to a connected lock", async () => {
    const { server, lock } = await harness();
    const device = await lock(IMEI_A);

    server.requestGpsRefresh(IMEI_A, "bike-a");

    expect(await device.nextCommand()).toEqual({ cmd: "D1", params: ["10"] });
  });

  it("is a silent no-op for a lock with no live socket", async () => {
    const { server } = await harness();
    // No connection for IMEI_A at all — must not throw.
    expect(() => server.requestGpsRefresh(IMEI_A, "bike-a")).not.toThrow();
  });

  it("stops the burst early (D1,0) the moment a valid fix lands", async () => {
    const { server, lock } = await harness();
    const device = await lock(IMEI_A);

    server.requestGpsRefresh(IMEI_A, "bike-a");
    expect(await device.nextCommand()).toEqual({ cmd: "D1", params: ["10"] });

    // record() (which drives the early-stop) runs and is awaited BEFORE the
    // protocol ack is written (see OmniConnection.onFrame), so D1,0 lands
    // ahead of the D0 ack on the wire.
    device.sendPosition(54.9442, 20.1561);
    expect(await device.nextCommand()).toEqual({ cmd: "D1", params: ["0"] }); // early-stop
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["D0"] }); // protocol ack, unrelated to the refresh
  });

  it("does NOT send an extra D1,0 when a fix lands with no refresh armed", async () => {
    const { lock } = await harness();
    const device = await lock(IMEI_A);

    device.sendPosition(54.9442, 20.1561); // no requestGpsRefresh call at all
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["D0"] });
    await expect(device.nextCommand(150)).rejects.toThrow(/timed out/);
  });

  it("D1 ownership transfer: a later D1 send (e.g. ride start) on the same lock cancels the stale auto-stop, so a subsequent fix does not turn its tracking off", async () => {
    const { server, lock } = await harness();
    const device = await lock(IMEI_A);

    server.requestGpsRefresh(IMEI_A, "bike-a");
    expect(await device.nextCommand()).toEqual({ cmd: "D1", params: ["10"] });

    // Simulate a ride starting on this same lock mid-burst: ride.ts's own D1
    // send now owns tracking, and must not be undone by the refresh burst's
    // now-stale auto-stop timer.
    expect(server.sendToDevice(IMEI_A, "D1", [10])).toBe(true);
    expect(await device.nextCommand()).toEqual({ cmd: "D1", params: ["10"] });

    device.sendPosition(54.9442, 20.1561);
    expect(await device.nextCommand()).toEqual({ cmd: "Re", params: ["D0"] });
    // No further D1 command should arrive — the refresh's auto-stop was
    // already cancelled by the ride-start D1 send above.
    await expect(device.nextCommand(150)).rejects.toThrow(/timed out/);
  });

  it("clears its bookkeeping on disconnect, without leaking a dangling auto-stop", async () => {
    const { server, lock } = await harness();
    const device = await lock(IMEI_A);

    server.requestGpsRefresh(IMEI_A, "bike-a");
    expect(await device.nextCommand()).toEqual({ cmd: "D1", params: ["10"] });

    device.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Reconnecting and sending a fix must not surface any leftover D1,0 from
    // the previous connection's now-defunct burst.
    const device2 = await lock(IMEI_A);
    device2.sendPosition(54.9442, 20.1561);
    expect(await device2.nextCommand()).toEqual({ cmd: "Re", params: ["D0"] });
    await expect(device2.nextCommand(150)).rejects.toThrow(/timed out/);
  });

  it("only targets the requested lock, leaving an unrelated connected lock untouched", async () => {
    const { server, lock } = await harness();
    const deviceA = await lock(IMEI_A);
    const deviceB = await lock(IMEI_B);

    server.requestGpsRefresh(IMEI_A, "bike-a");

    expect(await deviceA.nextCommand()).toEqual({ cmd: "D1", params: ["10"] });
    await expect(deviceB.nextCommand(150)).rejects.toThrow(/timed out/);
  });
});

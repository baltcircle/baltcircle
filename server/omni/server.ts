// TCP ingest server for OMNI horseshoe locks (OC32, bike version).
//
// Runs as its own process (server/omni/index.ts) so restarting the Express API
// never drops the persistent lock connections, and vice versa. Locks hold a
// long-lived TCP socket open and heartbeat every ~4 minutes; a fleet of 100-200
// therefore means 100-200 idle sockets and a low, steady packet rate.
//
// This module is deliberately side-effect free at import time and takes its
// store/logger by injection, so the whole thing can be driven end-to-end in
// tests against a fake store without a live Postgres.
import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "pino";
import { realToMap } from "@shared/geo";
import {
  OmniFramer, batteryPercent, buildAck, buildServerPacket, decodeMessage,
  parseDeviceFrame, type OmniMessage,
} from "@shared/omni/protocol";
import {
  TelemetryWriter, type BikeLiveUpdate, type OmniStore, type TelemetryRow,
  type TelemetryWriterOptions,
} from "./store";

export interface OmniServerOptions {
  store: OmniStore;
  logger: Logger;
  port: number;
  host?: string;
  /** Hard cap on concurrent sockets; excess connections are closed at accept. */
  maxConnections?: number;
  /** Close a socket that has sent nothing for this long (~3 missed H0s). */
  idleTimeoutMs?: number;
  /** Close a socket that has not sent a valid first packet within this long. */
  handshakeTimeoutMs?: number;
  /** Largest single frame accepted before the connection is treated as hostile. */
  maxFrameBytes?: number;
  /** Minimum spacing between persisted positionless status rows, per bike. */
  statusMinIntervalMs?: number;
  writer?: TelemetryWriterOptions;
}

/** A GPS date more than this far from now is treated as a bad device clock. */
const MAX_CLOCK_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a resolved IMEI -> bike mapping is trusted before re-reading. */
const IMEI_CACHE_TTL_MS = 60_000;
/** How long an unknown IMEI is remembered, to keep reconnect loops off the DB. */
const IMEI_NEGATIVE_TTL_MS = 300_000;
/**
 * Cache entries kept before the whole map is dropped. The port is public, so
 * every distinct spoofed IMEI would otherwise add a permanent entry; a fleet
 * needs one entry per lock, and re-resolving after a flush costs one query.
 */
const IMEI_CACHE_MAX_ENTRIES = 5_000;

interface CacheEntry {
  bikeId: string | null;
  expiresAt: number;
}

let nextConnectionId = 1;

export class OmniTcpServer {
  private readonly server: Server;
  private readonly log: Logger;
  private readonly writer: TelemetryWriter;
  private readonly opts: Required<Omit<OmniServerOptions, "store" | "logger" | "writer" | "host">>
    & { host: string };

  /** Live sockets keyed by IMEI. At most one connection per device. */
  private readonly byImei = new Map<string, OmniConnection>();
  /** Sockets accepted but not yet bound to a device. */
  private readonly pending = new Set<OmniConnection>();
  private readonly imeiCache = new Map<string, CacheEntry>();
  private readonly lastStatusWrite = new Map<string, number>();

  constructor(private readonly options: OmniServerOptions) {
    this.log = options.logger.child({ module: "omni-tcp" });
    this.opts = {
      port: options.port,
      host: options.host ?? "0.0.0.0",
      maxConnections: options.maxConnections ?? 500,
      idleTimeoutMs: options.idleTimeoutMs ?? 15 * 60_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 60_000,
      maxFrameBytes: options.maxFrameBytes ?? 4096,
      statusMinIntervalMs: options.statusMinIntervalMs ?? 60_000,
    };

    this.writer = new TelemetryWriter(options.store, {
      ...options.writer,
      onError: (err, dropped) =>
        this.log.error({ err, droppedRows: dropped }, "telemetry batch write failed"),
      onOverflow: (dropped) =>
        this.log.warn({ droppedRows: dropped }, "telemetry queue full, shedding reports"),
    });

    this.server = createServer((socket) => this.accept(socket));
    this.server.on("error", (err) => this.log.error({ err }, "tcp server error"));
  }

  get connectionCount(): number {
    return this.byImei.size + this.pending.size;
  }

  /** Address actually bound (useful when listening on port 0 in tests). */
  get port(): number {
    const addr = this.server.address();
    return addr && typeof addr === "object" ? addr.port : this.opts.port;
  }

  async listen(): Promise<void> {
    await this.options.store.resetAllLocksOffline();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.log.info(
      { port: this.port, host: this.opts.host, maxConnections: this.opts.maxConnections },
      "OMNI lock TCP server listening",
    );
  }

  /**
   * Push a command to a connected lock (§1.1 server->lock framing). Returns
   * false when the device has no live socket.
   */
  sendToDevice(imei: string, cmd: string, params: (string | number)[] = []): boolean {
    const conn = this.byImei.get(imei);
    if (!conn) return false;
    return conn.send(buildServerPacket({ imei, cmd, params }));
  }

  async close(): Promise<void> {
    // Sockets first: net.Server.close() only invokes its callback once every
    // connection has ended, so closing before tearing down the live locks would
    // never resolve.
    for (const conn of Array.from(this.byImei.values()).concat(Array.from(this.pending))) {
      conn.destroy("server_shutdown");
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.writer.close();
    this.log.info("OMNI lock TCP server stopped");
  }

  // -------------------------------------------------------------------------

  private accept(socket: Socket): void {
    if (this.connectionCount >= this.opts.maxConnections) {
      this.log.warn(
        { remote: socket.remoteAddress, connections: this.connectionCount },
        "connection refused: at capacity",
      );
      socket.destroy();
      return;
    }
    const conn = new OmniConnection(socket, this, this.log, this.opts);
    this.pending.add(conn);
  }

  /** @internal Called by a connection once it has a valid frame with an IMEI. */
  async bind(conn: OmniConnection, imei: string): Promise<boolean> {
    const bikeId = await this.resolveBike(imei);
    if (bikeId === null) {
      this.log.warn({ imei, remote: conn.remote }, "rejecting unregistered lock IMEI");
      conn.destroy("unknown_imei");
      return false;
    }
    if (conn.isClosed) {
      // The socket went away during the IMEI lookup. Registering it now would
      // park a dead connection in the registry forever: release() has already
      // run, so nothing would ever evict it, the slot would swallow every
      // command sent to that lock, and the bike would read online for good.
      this.log.info({ imei, connId: conn.id }, "socket closed during IMEI lookup");
      return false;
    }

    const existing = this.byImei.get(imei);

    // Claim the registry slot before tearing down any predecessor: release()
    // only gives up the slot when the closing socket still owns it, so doing
    // this in the other order would let the stale socket's teardown mark a
    // device offline microseconds after it reconnected.
    this.pending.delete(conn);
    this.byImei.set(imei, conn);
    conn.attach(imei, bikeId);

    if (existing) {
      // The device reconnected (NAT rebind, signal loss) without the old socket
      // ever being FIN'd. Drop the stale one rather than leak it.
      this.log.info({ imei, staleConnId: existing.id, newConnId: conn.id }, "replacing stale socket");
      existing.destroy("replaced_by_reconnect");
    }

    try {
      await this.options.store.setLockOnline(imei, true, Date.now());
    } catch (err) {
      this.log.error({ err, imei }, "failed to mark lock online");
    }
    this.log.info({ imei, bikeId, connId: conn.id, remote: conn.remote }, "lock connected");
    return true;
  }

  /** @internal */
  release(conn: OmniConnection, reason: string): void {
    this.pending.delete(conn);
    if (!conn.imei) return;
    // Only clear the registry slot if this socket still owns it: a stale socket
    // being torn down after replacement must not evict its successor.
    if (this.byImei.get(conn.imei) !== conn) return;

    this.byImei.delete(conn.imei);
    const imei = conn.imei;
    this.options.store.setLockOnline(imei, false, Date.now())
      .catch((err) => this.log.error({ err, imei }, "failed to mark lock offline"));
    this.log.info({ imei, bikeId: conn.bikeId, connId: conn.id, reason }, "lock disconnected");
  }

  /** @internal */
  record(conn: OmniConnection, message: OmniMessage, receivedAt: number): void {
    const bikeId = conn.bikeId;
    const imei = conn.imei;
    if (!bikeId || !imei) return;

    const built = buildTelemetry(bikeId, imei, message, receivedAt);
    if (!built) return;

    // Positionless status chatter is throttled per bike so a misbehaving device
    // cannot turn into a write storm. Positions and alarms always land.
    if (built.throttleable) {
      const last = this.lastStatusWrite.get(bikeId) ?? 0;
      if (receivedAt - last < this.opts.statusMinIntervalMs) return;
      this.lastStatusWrite.set(bikeId, receivedAt);
    }

    this.writer.add(built.row, built.live);
  }

  private async resolveBike(imei: string): Promise<string | null> {
    const now = Date.now();
    const hit = this.imeiCache.get(imei);
    if (hit && hit.expiresAt > now) return hit.bikeId;

    let bikeId: string | null = null;
    try {
      bikeId = await this.options.store.findBikeIdByImei(imei);
    } catch (err) {
      this.log.error({ err, imei }, "IMEI lookup failed");
      return null;
    }
    if (this.imeiCache.size >= IMEI_CACHE_MAX_ENTRIES) this.imeiCache.clear();
    this.imeiCache.set(imei, {
      bikeId,
      expiresAt: now + (bikeId ? IMEI_CACHE_TTL_MS : IMEI_NEGATIVE_TTL_MS),
    });
    return bikeId;
  }
}

// ---------------------------------------------------------------------------

class OmniConnection {
  readonly id = nextConnectionId++;
  readonly remote: string;
  imei: string | null = null;
  bikeId: string | null = null;

  private readonly framer: OmniFramer;
  private handshakeTimer: NodeJS.Timeout | null;
  private binding: Promise<boolean> | null = null;
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly server: OmniTcpServer,
    private readonly log: Logger,
    private readonly opts: {
      idleTimeoutMs: number;
      handshakeTimeoutMs: number;
      maxFrameBytes: number;
    },
  ) {
    this.remote = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
    this.framer = new OmniFramer(opts.maxFrameBytes);

    socket.setNoDelay(true);
    socket.setTimeout(opts.idleTimeoutMs);

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("timeout", () => {
      this.log.warn({ connId: this.id, imei: this.imei }, "idle timeout, closing lock socket");
      this.destroy("idle_timeout");
    });
    socket.on("error", (err) => {
      this.log.warn({ connId: this.id, imei: this.imei, err: err.message }, "lock socket error");
    });
    socket.on("close", () => this.onClose());

    this.handshakeTimer = setTimeout(() => {
      if (!this.imei) {
        this.log.warn({ connId: this.id, remote: this.remote }, "no valid packet, closing socket");
        this.destroy("handshake_timeout");
      }
    }, opts.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  attach(imei: string, bikeId: string): void {
    this.imei = imei;
    this.bikeId = bikeId;
    this.clearHandshakeTimer();
  }

  send(packet: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    return this.socket.write(packet);
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHandshakeTimer();
    this.socket.destroy();
    this.server.release(this, reason);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHandshakeTimer();
    this.server.release(this, "peer_closed");
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    for (const event of this.framer.push(chunk)) {
      if (event.kind === "error") {
        this.log.warn(
          { connId: this.id, imei: this.imei, reason: event.reason, bytes: event.bytes },
          "framing error, closing lock socket",
        );
        this.destroy(event.reason);
        return;
      }
      // Each frame is handled in isolation: one malformed packet is logged and
      // skipped, it must not tear down a healthy connection or the process.
      this.handleFrame(event.text).catch((err) => {
        this.log.error({ err, connId: this.id, imei: this.imei }, "unhandled frame error");
      });
    }
  }

  private async handleFrame(text: string): Promise<void> {
    if (this.closed) return;
    const receivedAt = Date.now();

    const parsed = parseDeviceFrame(text);
    if (!parsed.ok) {
      this.log.warn(
        { connId: this.id, imei: this.imei, reason: parsed.reason, frame: truncate(text) },
        "rejecting malformed frame",
      );
      return;
    }
    const { frame } = parsed;

    if (!this.imei) {
      // First valid packet decides which device this socket belongs to.
      // Serialised so a burst of coalesced packets cannot start two binds.
      this.binding ??= this.server.bind(this, frame.imei);
      if (!(await this.binding)) return;
    } else if (frame.imei !== this.imei) {
      // A bound socket switching IMEI mid-session is either a device bug or a
      // spoofing attempt; neither is something to trust.
      this.log.warn(
        { connId: this.id, imei: this.imei, claimed: frame.imei },
        "IMEI changed mid-session, closing socket",
      );
      this.destroy("imei_mismatch");
      return;
    }
    if (this.closed) return;

    const decoded = decodeMessage(frame);
    if (!decoded.ok) {
      this.log.warn(
        { connId: this.id, imei: this.imei, cmd: frame.cmd, reason: decoded.reason },
        "rejecting invalid payload",
      );
      return;
    }

    this.log.debug(
      { connId: this.id, imei: this.imei, bikeId: this.bikeId, cmd: frame.cmd },
      "lock report",
    );
    this.server.record(this, decoded.message, receivedAt);

    const ack = buildAck(frame.imei, frame.cmd, receivedAt);
    if (ack) this.send(ack);
  }
}

// ---------------------------------------------------------------------------

interface BuiltTelemetry {
  row: TelemetryRow;
  live?: BikeLiveUpdate;
  /** Positionless status rows may be dropped under throttling. */
  throttleable: boolean;
}

function emptyRow(bikeId: string, imei: string, cmd: string, t: number): TelemetryRow {
  return {
    bikeId, imei, cmd, t,
    x: null, y: null, lat: null, lng: null,
    satellites: null, hdop: null, altitudeM: null,
    voltageCv: null, batteryPct: null, signalLevel: null,
    locked: null, alarmCode: null,
  };
}

/**
 * Turn a decoded message into the row (and live-state patch) to persist.
 * Returns null for messages that carry no telemetry worth storing.
 */
export function buildTelemetry(
  bikeId: string,
  imei: string,
  message: OmniMessage,
  receivedAt: number,
): BuiltTelemetry | null {
  switch (message.type) {
    case "checkin": {
      const row = emptyRow(bikeId, imei, "Q0", receivedAt);
      row.voltageCv = message.voltageCv;
      row.batteryPct = batteryPercent(message.voltageCv);
      return {
        row,
        live: { bikeId, t: receivedAt, batteryPct: row.batteryPct },
        throttleable: true,
      };
    }

    case "heartbeat": {
      const row = emptyRow(bikeId, imei, "H0", receivedAt);
      row.voltageCv = message.voltageCv;
      row.batteryPct = batteryPercent(message.voltageCv);
      row.signalLevel = message.signal;
      row.locked = message.locked;
      return {
        row,
        live: { bikeId, t: receivedAt, batteryPct: row.batteryPct },
        throttleable: true,
      };
    }

    case "status": {
      const row = emptyRow(bikeId, imei, "S5", receivedAt);
      row.voltageCv = message.voltageCv;
      row.batteryPct = batteryPercent(message.voltageCv);
      row.signalLevel = message.signal;
      row.satellites = message.satellites;
      row.locked = message.locked;
      return {
        row,
        live: { bikeId, t: receivedAt, batteryPct: row.batteryPct },
        throttleable: true,
      };
    }

    case "position": {
      // A "no fix" report is real information (the lock is awake but blind) but
      // has nothing to plot, so it is stored as a throttleable status row.
      if (!message.valid || !message.fix) {
        return { row: emptyRow(bikeId, imei, "D0", receivedAt), throttleable: true };
      }
      const fix = message.fix;
      // Trust the GPS clock only when it is plausible; a lock that has not got
      // a date yet can report 1970 or 2080 and would corrupt the ride window.
      const fixedAt = fix.fixedAt !== null && Math.abs(fix.fixedAt - receivedAt) <= MAX_CLOCK_SKEW_MS
        ? fix.fixedAt
        : receivedAt;

      const { x, y } = realToMap(fix.lat, fix.lng);
      const row = emptyRow(bikeId, imei, "D0", fixedAt);
      row.lat = fix.lat;
      row.lng = fix.lng;
      row.x = x;
      row.y = y;
      row.satellites = fix.satellites;
      row.hdop = fix.hdop;
      row.altitudeM = fix.altitudeM;
      return { row, live: { bikeId, t: fixedAt, x, y }, throttleable: false };
    }

    case "alarm": {
      const row = emptyRow(bikeId, imei, "W0", receivedAt);
      row.alarmCode = message.code;
      return { row, throttleable: false };
    }

    case "unlockResult":
    case "lockReport":
    case "other":
      // Rental lifecycle and the auxiliary command set (upgrade, BLE key, RFID,
      // beacon) are acknowledged and logged but are not position/battery
      // telemetry, so they do not belong in bike_telemetry.
      return null;
  }
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

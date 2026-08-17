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
  TelemetryWriter, type BikeLiveUpdate, type LockAuthResult, type OmniStore, type TelemetryRow,
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
  /**
   * New-connection admission control per source IP (audit F-05). Locks may
   * share carrier CGNAT, so this caps the *rate* of new connection attempts
   * rather than concurrent sockets per IP — a legitimate fleet behind one
   * CGNAT IP can still hold many concurrent connections, it just cannot
   * open new ones faster than this.
   */
  maxNewConnectionsPerIp?: number;
  /** Sliding window over which `maxNewConnectionsPerIp` is enforced. */
  newConnectionWindowMs?: number;
  /**
   * Per-connection frame-rate limiter (audit F-06): sustained token-bucket
   * refill rate. Real firmware heartbeats every ~4 min and position-tracks at
   * most every few seconds, so this has an order of magnitude of headroom
   * while still bounding how much CPU/DB write amplification one abusive or
   * malfunctioning socket can cause.
   */
  maxFramesPerSecond?: number;
  /** Token-bucket burst capacity, so a batch of frames coalesced by TCP after a brief stall is not mistaken for a flood. */
  frameBucketCapacity?: number;
  /** Minimum spacing between persisted positionless status rows, per bike. */
  statusMinIntervalMs?: number;
  /** Mark an active lock offline after this quiet period. */
  offlineAfterMs?: number;
  /** How often to scan persisted lock presence. */
  offlineSweepIntervalMs?: number;
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
/** Cap on distinct source-IP buckets tracked for connection-rate limiting. */
const CONNECTION_ATTEMPT_MAX_ENTRIES = 5_000;

interface CacheEntry {
  result: LockAuthResult;
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
  /** Fixed-window new-connection counters, keyed by normalised source IP. */
  private readonly connectionAttempts = new Map<string, { count: number; windowStart: number }>();
  private readonly lastStatusWrite = new Map<string, number>();
  private readonly pendingUnlocks = new Map<string, {
    resolve: (value: { success: boolean }) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
    imei: string;
  }>();
  /**
   * True per-IMEI mutex (audit F-07): `pendingUnlocks` is keyed by
   * imei+user+second, so two different user/second tuples targeting the same
   * lock were never mutually exclusive. This set is the single source of
   * truth for "a command is currently outstanding for this lock".
   */
  private readonly imeiCommandInFlight = new Set<string>();
  private offlineSweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: OmniServerOptions) {
    this.log = options.logger.child({ module: "omni-tcp" });
    this.opts = {
      port: options.port,
      host: options.host ?? "0.0.0.0",
      maxConnections: options.maxConnections ?? 500,
      idleTimeoutMs: options.idleTimeoutMs ?? 15 * 60_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 60_000,
      maxFrameBytes: options.maxFrameBytes ?? 4096,
      maxNewConnectionsPerIp: options.maxNewConnectionsPerIp ?? 20,
      newConnectionWindowMs: options.newConnectionWindowMs ?? 60_000,
      maxFramesPerSecond: options.maxFramesPerSecond ?? 5,
      frameBucketCapacity: options.frameBucketCapacity ?? 20,
      statusMinIntervalMs: options.statusMinIntervalMs ?? 60_000,
      offlineAfterMs: options.offlineAfterMs ?? 10 * 60_000,
      offlineSweepIntervalMs: options.offlineSweepIntervalMs ?? 60_000,
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
    this.offlineSweepTimer = setInterval(() => void this.sweepOfflineLocks(), this.opts.offlineSweepIntervalMs);
    this.offlineSweepTimer.unref?.();
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

  /** Send L0 and resolve when the lock echoes the same user/timestamp tuple. */
  sendUnlockCommand(imei: string, userId: string | number): Promise<{ success: boolean }> {
    const conn = this.byImei.get(imei);
    if (!conn) return Promise.reject(new Error("lock is not connected"));
    const user = String(userId);
    if (!/^\d+$/.test(user)) return Promise.reject(new Error("user id must be an unsigned integer"));
    // F-07: serialize on the lock itself, not on the user/second tuple — two
    // requests for the same IMEI (e.g. a rider's self-service start racing an
    // operator's manual unlock) must never both be in flight at once.
    if (this.imeiCommandInFlight.has(imei)) {
      return Promise.reject(new Error("a command is already pending for this lock"));
    }
    const seconds = Math.floor(Date.now() / 1000);
    const key = unlockKey(imei, user, seconds);
    if (this.pendingUnlocks.has(key)) return Promise.reject(new Error("unlock command already pending"));
    this.imeiCommandInFlight.add(imei);
    return new Promise((resolve, reject) => {
      const settle = (fn: () => void) => {
        this.pendingUnlocks.delete(key);
        this.imeiCommandInFlight.delete(imei);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error("unlock command timed out")));
      }, 15_000);
      timer.unref?.();
      this.pendingUnlocks.set(key, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (err) => settle(() => reject(err)),
        timer,
        imei,
      });
      if (!conn.send(buildServerPacket({ imei, cmd: "L0", params: [0, user, seconds] }))) {
        clearTimeout(timer);
        settle(() => reject(new Error("lock socket is not writable")));
      }
    });
  }

  async close(): Promise<void> {
    if (this.offlineSweepTimer !== null) clearInterval(this.offlineSweepTimer);
    this.offlineSweepTimer = null;
    this.pendingUnlocks.forEach((pending, key) => {
      clearTimeout(pending.timer);
      pending.reject(new Error("gateway is shutting down"));
      this.pendingUnlocks.delete(key);
    });
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
    const ip = normalizeIp(socket.remoteAddress);
    if (this.isNewConnectionRateLimited(ip)) {
      this.log.warn(
        { remote: ip, limit: this.opts.maxNewConnectionsPerIp, windowMs: this.opts.newConnectionWindowMs },
        "connection refused: source IP exceeded new-connection rate limit",
      );
      socket.destroy();
      return;
    }
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

  /**
   * Fixed-window counter per source IP (audit F-05). A single misbehaving or
   * spoofing source dialling in repeatedly must not be able to burn CPU/DB on
   * IMEI lookups or exhaust the global connection cap for everyone else.
   */
  private isNewConnectionRateLimited(ip: string): boolean {
    const now = Date.now();
    if (this.connectionAttempts.size >= CONNECTION_ATTEMPT_MAX_ENTRIES) {
      // Sweep expired buckets first so a legitimate traffic spike (e.g. a mass
      // reconnect after a network blip) does not get everyone's counters reset
      // early just because many distinct IPs are active at once.
      this.connectionAttempts.forEach((entry, key) => {
        if (now - entry.windowStart > this.opts.newConnectionWindowMs) this.connectionAttempts.delete(key);
      });
      if (this.connectionAttempts.size >= CONNECTION_ATTEMPT_MAX_ENTRIES) this.connectionAttempts.clear();
    }

    const entry = this.connectionAttempts.get(ip);
    if (!entry || now - entry.windowStart > this.opts.newConnectionWindowMs) {
      this.connectionAttempts.set(ip, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > this.opts.maxNewConnectionsPerIp;
  }

  /** @internal Called by a connection once it has a valid frame with an IMEI. */
  async bind(conn: OmniConnection, imei: string): Promise<boolean> {
    // A device is never authorised just by dialling in: `resolveAuth` only
    // ever reads a `locks` row an admin already created via
    // `POST /api/admin/locks` (fail-closed — audit F-01/F-03/F-09). Unknown
    // and decommissioned IMEIs are rejected before the socket ever reaches
    // the registry, so a bike is only ever attached when it is a genuinely
    // provisioned device (an unassigned bike_id on a provisioned row is still
    // a valid, authorised state — only telemetry needs a bike_id).
    const auth = await this.resolveAuth(imei);
    if (!auth.authorized) {
      this.log.warn({ imei, remote: conn.remote, reason: auth.reason }, "rejecting unauthorized lock IMEI");
      conn.destroy(auth.reason === "decommissioned" ? "decommissioned_imei" : "unknown_imei");
      return false;
    }
    const bikeId = auth.bikeId;

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
    this.pendingUnlocks.forEach((pending, key) => {
      if (!key.startsWith(`${imei}:`)) return;
      clearTimeout(pending.timer);
      this.pendingUnlocks.delete(key);
      pending.reject(new Error(`lock disconnected: ${reason}`));
    });
    this.options.store.setLockOnline(imei, false, Date.now())
      .catch((err) => this.log.error({ err, imei }, "failed to mark lock offline"));
    this.log.info({ imei, bikeId: conn.bikeId, connId: conn.id, reason }, "lock disconnected");
  }

  /** @internal */
  async record(conn: OmniConnection, message: OmniMessage, receivedAt: number): Promise<void> {
    const bikeId = conn.bikeId;
    const imei = conn.imei;
    if (!imei) return;

    if (this.options.store.persistLockReport) {
      try {
        await this.options.store.persistLockReport(imei, message, receivedAt);
      } catch (err) {
        this.log.error({ err, imei, type: message.type }, "failed to persist lock report");
      }
    }
    if (message.type === "unlockResult") this.resolveUnlock(imei, message);
    if (!bikeId) return;

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

  private resolveUnlock(imei: string, message: Extract<OmniMessage, { type: "unlockResult" }>): void {
    if (message.at === null) return;
    const key = unlockKey(imei, message.userId, Math.floor(message.at / 1000));
    const pending = this.pendingUnlocks.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingUnlocks.delete(key);
    pending.resolve({ success: message.success });
  }

  private async sweepOfflineLocks(): Promise<void> {
    if (!this.options.store.markLocksOfflineBefore) return;
    try {
      await this.options.store.markLocksOfflineBefore(Date.now() - this.opts.offlineAfterMs);
    } catch (err) {
      this.log.warn({ err }, "failed to sweep stale locks offline");
    }
  }

  /**
   * Single fail-closed IMEI resolver used by every connection, negative-cached
   * so a spoofed or scanning IMEI cannot force a database round-trip on every
   * reconnect (audit F-05). Prefers the store's registry lookup (`resolveLock`,
   * which never creates a row) and falls back to a plain bike_id lookup for
   * stores that have not adopted the registry — wrapped in the same
   * fail-closed shape so `bind()` only ever branches on `authorized`.
   */
  private async resolveAuth(imei: string): Promise<LockAuthResult> {
    const now = Date.now();
    const hit = this.imeiCache.get(imei);
    if (hit && hit.expiresAt > now) return hit.result;

    let result: LockAuthResult;
    try {
      if (this.options.store.resolveLock) {
        result = await this.options.store.resolveLock(imei, now);
      } else {
        const bikeId = await this.options.store.findBikeIdByImei(imei);
        result = bikeId !== null ? { authorized: true, bikeId } : { authorized: false, reason: "unknown" };
      }
    } catch (err) {
      this.log.error({ err, imei }, "IMEI lookup failed");
      return { authorized: false, reason: "unknown" };
    }

    if (this.imeiCache.size >= IMEI_CACHE_MAX_ENTRIES) this.imeiCache.clear();
    this.imeiCache.set(imei, {
      result,
      expiresAt: now + (result.authorized ? IMEI_CACHE_TTL_MS : IMEI_NEGATIVE_TTL_MS),
    });
    if (!result.authorized && result.reason === "unknown") this.noteUnassigned(imei, now);
    return result;
  }

  /**
   * Remember that an unregistered lock is alive, so an operator can pick it in
   * the admin bike form. Reached only on a cache miss, so the negative cache
   * already throttles this to one write per IMEI per IMEI_NEGATIVE_TTL_MS
   * however hard a device (or a spoofer) reconnects.
   *
   * Not awaited: the caller's job is to reject the connection, and discovery
   * bookkeeping must neither delay that nor fail it.
   */
  private noteUnassigned(imei: string, at: number): void {
    void this.options.store.recordUnassignedLock(imei, at).catch((err) => {
      this.log.warn({ err, imei }, "failed to record unassigned lock sighting");
    });
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

  /** Token-bucket state for the F-06 per-connection frame-rate limiter. */
  private frameTokens: number;
  private frameTokensRefilledAt: number;

  constructor(
    private readonly socket: Socket,
    private readonly server: OmniTcpServer,
    private readonly log: Logger,
    private readonly opts: {
      idleTimeoutMs: number;
      handshakeTimeoutMs: number;
      maxFrameBytes: number;
      maxFramesPerSecond: number;
      frameBucketCapacity: number;
    },
  ) {
    this.frameTokens = opts.frameBucketCapacity;
    this.frameTokensRefilledAt = Date.now();
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

  attach(imei: string, bikeId: string | null): void {
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
      // F-06: cap the sustained decode/persist rate per socket. A single
      // connection sending frames faster than any real lock could must not be
      // able to turn into a CPU or database write-amplification attack just
      // because it passed the IMEI/frame-format checks.
      if (!this.takeFrameToken()) {
        this.log.warn(
          { connId: this.id, imei: this.imei, remote: this.remote },
          "frame rate limit exceeded, closing lock socket",
        );
        this.destroy("frame_rate_exceeded");
        return;
      }
      // Each frame is handled in isolation: one malformed packet is logged and
      // skipped, it must not tear down a healthy connection or the process.
      this.handleFrame(event.text).catch((err) => {
        this.log.error({ err, connId: this.id, imei: this.imei }, "unhandled frame error");
      });
    }
  }

  /** Refills by elapsed time, then attempts to spend one token. */
  private takeFrameToken(): boolean {
    const now = Date.now();
    const elapsedSec = (now - this.frameTokensRefilledAt) / 1000;
    if (elapsedSec > 0) {
      this.frameTokens = Math.min(
        this.opts.frameBucketCapacity,
        this.frameTokens + elapsedSec * this.opts.maxFramesPerSecond,
      );
      this.frameTokensRefilledAt = now;
    }
    if (this.frameTokens < 1) return false;
    this.frameTokens -= 1;
    return true;
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
    await this.server.record(this, decoded.message, receivedAt);

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
        return { row: emptyRow(bikeId, imei, message.cmd, receivedAt), throttleable: true };
      }
      const fix = message.fix;
      // Trust the GPS clock only when it is plausible; a lock that has not got
      // a date yet can report 1970 or 2080 and would corrupt the ride window.
      const fixedAt = fix.fixedAt !== null && Math.abs(fix.fixedAt - receivedAt) <= MAX_CLOCK_SKEW_MS
        ? fix.fixedAt
        : receivedAt;

      const { x, y } = realToMap(fix.lat, fix.lng);
      const row = emptyRow(bikeId, imei, message.cmd, fixedAt);
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
    case "firmware":
    case "iccid":
    case "mac":
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

function unlockKey(imei: string, userId: string, timestampSeconds: number): string {
  return `${imei}:${userId}:${timestampSeconds}`;
}

/**
 * Node reports IPv4 peers on a dual-stack listener as IPv4-mapped IPv6
 * (`::ffff:1.2.3.4`). Without normalising, the same physical source would
 * split its attempts across two different rate-limit buckets.
 */
function normalizeIp(remoteAddress: string | undefined): string {
  if (!remoteAddress) return "unknown";
  return remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
}

// Simulated OMNI horseshoe lock speaking the real TCP wire protocol.
//
// Exists so the ingest server can be tested end-to-end without physical
// hardware: it emits genuine `*CMDR,OM,...#\n` frames built by the same codec
// the server parses, and understands the `Re` acknowledgements coming back.
//
// Used by server/omni/server.test.ts and, as a manual smoke tool, by
// script/omni-sim.ts.
import { connect, type Socket } from "node:net";
import { OmniFramer, buildDevicePacket } from "@shared/omni/protocol";

export interface MockLockOptions {
  imei: string;
  port: number;
  host?: string;
  /** Battery voltage in 0.01 V units (protocol §1.3.1, valid 320-420). */
  voltageCv?: number;
  /** Network signal quality (§1.3.2, valid 2-32). */
  signal?: number;
}

export interface ReceivedCommand {
  cmd: string;
  params: string[];
}

/**
 * A lock as far as the server is concerned. Every `send*` helper produces a
 * spec-shaped packet; `sendRaw` exists so tests can inject deliberately broken
 * or oddly-framed bytes.
 */
export class MockLock {
  private socket: Socket | null = null;
  private readonly framer = new OmniFramer();
  private readonly waiters: (() => void)[] = [];
  /** How far `nextCommand` has consumed into `received`. */
  private cursor = 0;

  /** Every server->lock command received, in order. */
  readonly received: ReceivedCommand[] = [];

  constructor(private readonly opts: MockLockOptions) {}

  get imei(): string {
    return this.opts.imei;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ port: this.opts.port, host: this.opts.host ?? "127.0.0.1" });
      socket.setNoDelay(true);
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        socket.on("error", () => { /* server-side teardown is expected in tests */ });
        socket.on("data", (chunk) => this.onData(chunk));
        this.socket = socket;
        resolve();
      });
    });
  }

  private onData(chunk: Buffer): void {
    for (const event of this.framer.push(chunk)) {
      if (event.kind !== "frame") continue;
      // The server prefixes 0xFFFF; the framer already resynchronised past it.
      const parts = event.text.slice(0, -1).split(",").map((p) => p.trim());
      this.received.push({ cmd: parts[4] ?? "", params: parts.slice(5) });
      this.waiters.splice(0).forEach((resume) => resume());
    }
  }

  /**
   * Consume the next unread server->lock command (e.g. a `Re` ack). Sequential
   * rather than "latest", so a test awaiting an ack cannot be satisfied by one
   * that arrived for an earlier packet.
   */
  async nextCommand(timeoutMs = 2000): Promise<ReceivedCommand> {
    while (this.cursor >= this.received.length) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for server command")),
          timeoutMs,
        );
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.received[this.cursor++];
  }

  private write(buf: Buffer): void {
    if (!this.socket || this.socket.destroyed) throw new Error("mock lock is not connected");
    this.socket.write(buf);
  }

  /** Emit an arbitrary byte sequence — for framing and malformed-input tests. */
  sendRaw(data: Buffer | string): void {
    this.write(typeof data === "string" ? Buffer.from(data, "latin1") : data);
  }

  packet(cmd: string, params: (string | number)[] = [], at?: number): Buffer {
    return buildDevicePacket({ imei: this.opts.imei, cmd, params, at });
  }

  /** §1.3.1 Q0 — periodic check-in carrying battery voltage. */
  sendCheckin(voltageCv = this.opts.voltageCv ?? 412): void {
    this.write(this.packet("Q0", [voltageCv]));
  }

  /** §1.3.2 H0 — keep-alive: lock state, voltage, signal. */
  sendHeartbeat(locked = true, voltageCv = this.opts.voltageCv ?? 412, signal = this.opts.signal ?? 28): void {
    this.write(this.packet("H0", [locked ? 1 : 0, voltageCv, signal]));
  }

  /**
   * §1.3.5 D0 — position report. Takes WGS84 degrees and encodes them back into
   * the NMEA `ddmm.mmmm` / `dddmm.mmmm` form the device actually transmits.
   */
  sendPosition(lat: number, lng: number, opts: { tracking?: boolean; satellites?: number; at?: number } = {}): void {
    const at = opts.at ?? Date.now();
    const d = new Date(at);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const utcTime = `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}.00`;
    const utcDate = `${p2(d.getUTCDate())}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCFullYear() % 100)}`;

    this.write(this.packet("D0", [
      opts.tracking ? 1 : 0, utcTime, "A",
      toNmea(Math.abs(lat), 2), lat >= 0 ? "N" : "S",
      toNmea(Math.abs(lng), 3), lng >= 0 ? "E" : "W",
      opts.satellites ?? 9, "0.21", utcDate, "10", "M", "A",
    ], at));
  }

  /** §1.3.5 note 2 — a well-formed report with no satellite fix. */
  sendNoFix(at = Date.now()): void {
    const d = new Date(at);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const utcTime = `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}.00`;
    const utcDate = `${p2(d.getUTCDate())}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCFullYear() % 100)}`;
    this.write(this.packet("D0", [0, utcTime, "V", "", "", "", "", "", "", utcDate, "", "", "N"], at));
  }

  /** §1.3.10 W0 — 1 illegal movement, 2 fall, 6 fall cleared. */
  sendAlarm(code: number): void {
    this.write(this.packet("W0", [code]));
  }

  /**
   * L0 — unlock result echo. Genuinely unprompted here (the harness never
   * arms a pending unlock through this class), which is exactly the shape
   * server.test.ts needs to exercise onUnsolicitedUnlockEcho (audit:
   * lock-open-while-available, 2026-09): a late echo the server has no
   * pending unlock tracked for. `at` is epoch seconds on the wire (§1.3.9);
   * defaults to "now" like the other send* helpers.
   */
  sendUnlockResult(success: boolean, opts: { userId?: string; at?: number } = {}): void {
    this.write(this.packet("L0", [success ? 0 : 1, opts.userId ?? "", Math.floor((opts.at ?? Date.now()) / 1000)]));
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Decimal degrees -> NMEA `ddmm.mmmm`, zero-padded to `degDigits` degree digits
 * (§1.3.5: "the previous 0 will also be transmitted").
 */
export function toNmea(absDegrees: number, degDigits: number): string {
  const deg = Math.floor(absDegrees);
  const minutes = (absDegrees - deg) * 60;
  const mm = minutes.toFixed(4).padStart(7, "0");
  return `${String(deg).padStart(degDigits, "0")}${mm}`;
}

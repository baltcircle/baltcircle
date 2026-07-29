// OMNI Horseshoe Lock (OC32 bike version) TCP wire protocol — codec.
//
// Source of truth: "Horseshoe Lock Device (Bike Version) TCP +BLE Interface
// Protocol", Shenzhen Omni Intelligent Technology, V2.0.7 (2024-08-03).
// Section references below point at that document.
//
// Wire format (§1.1):
//   server -> lock   0xFFFF *CMDS,OM,<imei15>,<yyMMddHHmmss>,<cmd>[,<params>]#\n
//   lock   -> server        *CMDR,OM,<imei15>,<yyMMddHHmmss>,<cmd>[,<params>]#\n
// 0xFFFF is two literal bytes (Appendix I shows the hex dump: FF FF 2A 43 4D 44
// 53 ... 23 0A), NOT the four characters "0xFFFF", and it is only ever prefixed
// by the server. Everything after it is 7-bit ASCII.
//
// NOTE ON CHECKSUMS: the TCP text protocol carries no CRC and no encryption.
// Appendix IV's CRC16 applies to the BLE frame format (§2.1, byte-oriented, has
// an explicit CRC field) and to firmware-upgrade payloads (§1.3.11 U0 / §1.3.12
// U1), neither of which is part of TCP framing. §1.1's table lists a row 9
// "Command check value, *" but no example packet anywhere in the document has
// such a field, and the row numbering (9, 10) runs past the 8 items the format
// string actually defines. We therefore validate structurally (header,
// manufacturer, IMEI shape, terminator, per-command arity and field ranges)
// rather than inventing a checksum the devices do not send.

export const OMNI_PREFIX = Uint8Array.from([0xff, 0xff]);
export const MANUFACTURER = "OM";
export const HEADER_SERVER = "*CMDS";
export const HEADER_DEVICE = "*CMDR";
export const FRAME_END = "#";

/** Commands the lock must be acknowledged for (§1.3.3, §1.3.4, §1.3.5, §1.3.10). */
const ACK_REQUIRED = new Set(["L0", "L1", "D0", "W0"]);

/** A device clock that has never been set reports all zeroes (see the §1.4.3 /
 *  §1.4.4 examples, which use `000000000000`). Treated as "no device time". */
const UNSET_TIMESTAMP = "000000000000";

// ---------------------------------------------------------------------------
// Frame-level parsing
// ---------------------------------------------------------------------------

export interface OmniFrame {
  /** Raw frame text including the leading `*` and trailing `#`. */
  raw: string;
  imei: string;
  /** Device clock as unix ms, or null when unset/unparseable. Advisory only. */
  deviceTime: number | null;
  cmd: string;
  params: string[];
}

export type ParseResult =
  | { ok: true; frame: OmniFrame }
  | { ok: false; reason: string };

const IMEI_RE = /^\d{15}$/;
const CMD_RE = /^[A-Za-z][A-Za-z0-9]$/;

/**
 * Parse one complete `*CMDR,...#` frame emitted by a lock. Structure only —
 * per-command payload decoding is `decodeMessage`.
 */
export function parseDeviceFrame(raw: string): ParseResult {
  const text = raw.trim();
  if (!text.startsWith("*")) return { ok: false, reason: "missing_start" };
  if (!text.endsWith(FRAME_END)) return { ok: false, reason: "missing_terminator" };

  // Strip the leading `*` and trailing `#`, then split. Fields are trimmed
  // because the vendor's own examples are inconsistent about padding
  // ("*CMDR ,OM,..." in §1.3.1 vs "*CMDR,OM,..." in §1.3.5).
  const body = text.slice(0, -1);
  const parts = body.split(",").map((p) => p.trim());
  if (parts.length < 5) return { ok: false, reason: "too_few_fields" };

  const [header, manufacturer, imei, timestamp, cmd] = parts;
  if (header !== HEADER_DEVICE) {
    // *CMDS is the server->lock direction; a lock sending it is malformed.
    return { ok: false, reason: header === HEADER_SERVER ? "wrong_direction" : "bad_header" };
  }
  if (manufacturer !== MANUFACTURER) return { ok: false, reason: "bad_manufacturer" };
  if (!IMEI_RE.test(imei)) return { ok: false, reason: "bad_imei" };
  if (!CMD_RE.test(cmd)) return { ok: false, reason: "bad_command" };

  return {
    ok: true,
    frame: { raw: text, imei, deviceTime: parseDeviceTimestamp(timestamp), cmd, params: parts.slice(5) },
  };
}

/**
 * `yyMMddHHmmss` -> unix ms, interpreted as UTC. Returns null for the all-zero
 * "clock unset" value or anything unparseable.
 *
 * AMBIGUITY: the document never states the timezone of this field. We read it
 * as UTC and treat it as advisory — persisted timestamps come from the GPS UTC
 * fields (D0) or from server receive time, never from this clock.
 */
export function parseDeviceTimestamp(ts: string): number | null {
  if (!/^\d{12}$/.test(ts) || ts === UNSET_TIMESTAMP) return null;
  const yy = Number(ts.slice(0, 2));
  const mo = Number(ts.slice(2, 4));
  const dd = Number(ts.slice(4, 6));
  const hh = Number(ts.slice(6, 8));
  const mi = Number(ts.slice(8, 10));
  const ss = Number(ts.slice(10, 12));
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 60) return null;
  return Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss);
}

/** unix ms -> the `yyMMddHHmmss` field used in outgoing frames (UTC). */
export function formatDeviceTimestamp(at: number): string {
  const d = new Date(at);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    p2(d.getUTCFullYear() % 100) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) +
    p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds())
  );
}

/**
 * Build a server->lock packet: 0xFFFF prefix + ASCII body + `#\n` (§1.1,
 * Appendix I).
 */
export function buildServerPacket(opts: {
  imei: string;
  cmd: string;
  params?: (string | number)[];
  at?: number;
}): Buffer {
  const { imei, cmd } = opts;
  if (!IMEI_RE.test(imei)) throw new Error(`invalid IMEI: ${imei}`);
  const fields = [
    HEADER_SERVER, MANUFACTURER, imei,
    formatDeviceTimestamp(opts.at ?? Date.now()), cmd,
    ...(opts.params ?? []).map(String),
  ];
  return Buffer.concat([OMNI_PREFIX, Buffer.from(`${fields.join(",")}#\n`, "latin1")]);
}

/** Build a lock->server packet. Used by the simulator and by tests. */
export function buildDevicePacket(opts: {
  imei: string;
  cmd: string;
  params?: (string | number)[];
  at?: number;
  /** Emit the all-zero "clock unset" timestamp instead of a real one. */
  unsetClock?: boolean;
}): Buffer {
  const fields = [
    HEADER_DEVICE, MANUFACTURER, opts.imei,
    opts.unsetClock ? UNSET_TIMESTAMP : formatDeviceTimestamp(opts.at ?? Date.now()),
    opts.cmd,
    ...(opts.params ?? []).map(String),
  ];
  return Buffer.from(`${fields.join(",")}#\n`, "latin1");
}

/** The `Re` acknowledgement a lock expects for L0/L1/D0/W0, or null. */
export function buildAck(imei: string, cmd: string, at?: number): Buffer | null {
  if (!ACK_REQUIRED.has(cmd)) return null;
  return buildServerPacket({ imei, cmd: "Re", params: [cmd], at });
}

// ---------------------------------------------------------------------------
// Stream framing
// ---------------------------------------------------------------------------

export type FramerEvent =
  | { kind: "frame"; text: string }
  | { kind: "error"; reason: string; bytes: number };

/**
 * Reassembles `#`-terminated frames out of a TCP byte stream.
 *
 * A single `data` event may deliver half a packet, one packet, several packets
 * back to back, or a packet split mid-field, so framing cannot assume one read
 * == one packet. Bytes preceding a `*` (the 0xFFFF prefix if a device echoes
 * it, stray CR/LF, or line noise) are discarded to resynchronise.
 *
 * The buffer is bounded: a peer that never sends a terminator cannot grow it
 * without limit, it gets an `error` event and the caller drops the connection.
 */
export class OmniFramer {
  private buf = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = 4096) {}

  /** Bytes currently held pending a terminator. */
  get pending(): number {
    return this.buf.length;
  }

  push(chunk: Buffer): FramerEvent[] {
    const events: FramerEvent[] = [];
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    for (;;) {
      const start = this.buf.indexOf(0x2a); // '*'
      if (start === -1) {
        // No frame start in view. Keep nothing — but guard against a peer that
        // streams junk forever.
        if (this.buf.length > this.maxFrameBytes) {
          events.push({ kind: "error", reason: "junk_overflow", bytes: this.buf.length });
          this.buf = Buffer.alloc(0);
        }
        break;
      }
      if (start > 0) this.buf = this.buf.subarray(start);

      const end = this.buf.indexOf(0x23); // '#'
      if (end === -1) {
        if (this.buf.length > this.maxFrameBytes) {
          events.push({ kind: "error", reason: "frame_overflow", bytes: this.buf.length });
          this.buf = Buffer.alloc(0);
        }
        break;
      }

      events.push({ kind: "frame", text: this.buf.subarray(0, end + 1).toString("latin1") });
      this.buf = this.buf.subarray(end + 1);
    }

    return events;
  }
}

// ---------------------------------------------------------------------------
// Per-command payload decoding
// ---------------------------------------------------------------------------

export interface GpsFix {
  /** WGS84 decimal degrees (§1.3.5 note 3). */
  lat: number;
  lng: number;
  satellites: number | null;
  hdop: number | null;
  altitudeM: number | null;
  /** GPS UTC instant in unix ms, from the D0 date+time fields. */
  fixedAt: number | null;
}

export type OmniMessage =
  /** §1.3.1 — periodic check-in. Only payload is battery voltage. */
  | { type: "checkin"; voltageCv: number }
  /** §1.3.2 — keep-alive, default every 4 minutes. */
  | { type: "heartbeat"; locked: boolean; voltageCv: number; signal: number }
  /** §1.3.7 — lock information response. */
  | { type: "status"; voltageCv: number; signal: number; satellites: number; locked: boolean }
  /** §1.3.5 — position report (solicited or from tracking mode). */
  | { type: "position"; tracking: boolean; valid: boolean; fix: GpsFix | null }
  /** §1.3.3 — result of a server-issued unlock. */
  | { type: "unlockResult"; success: boolean; userId: string; at: number | null }
  /** §1.3.4 — the lock was closed; ends a rental. */
  | { type: "lockReport"; userId: string; at: number | null; rideMinutes: number | null }
  /** §1.3.10 — 1 illegal movement, 2 fall, 6 fall cleared. */
  | { type: "alarm"; code: number }
  /** Recognised frame we do not act on (upgrade, BLE key, RFID, beacon, ...). */
  | { type: "other"; cmd: string; params: string[] };

export type DecodeResult =
  | { ok: true; message: OmniMessage }
  | { ok: false; reason: string };

/** §1.3.1 etc: voltage is in units of 0.01 V, valid span 320..420 (3.20-4.20 V). */
export const VOLTAGE_MIN_CV = 320;
export const VOLTAGE_MAX_CV = 420;
/** §1.3.2: network signal quality, 2..32. */
const SIGNAL_MIN = 2;
const SIGNAL_MAX = 32;
const MAX_SATELLITES = 64;

function int(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  if (!/^[+-]?\d+$/.test(value)) return null;
  return Number(value);
}

function float(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  if (!/^[+-]?\d*\.?\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function inRange(n: number | null, lo: number, hi: number): number | null {
  return n !== null && n >= lo && n <= hi ? n : null;
}

/**
 * NMEA `ddmm.mmmm` / `dddmm.mmmm` -> signed decimal degrees (§1.3.5 note 3:
 * `lat = dd + mm.mmmm/60`, negative for S; `lng = ddd + mm.mmmm/60`, negative
 * for W). The number of degree digits is derived from the decimal point's
 * position so both widths work.
 */
export function nmeaToDecimal(value: string, hemisphere: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const dot = value.indexOf(".");
  const degDigits = (dot === -1 ? value.length : dot) - 2;
  if (degDigits < 1 || degDigits > 3) return null;

  const degrees = Number(value.slice(0, degDigits));
  const minutes = Number(value.slice(degDigits));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes) || minutes >= 60) return null;

  // Exact match, not a substring test: "" and "NS" are both substrings of
  // "NSEW", so a missing or garbled hemisphere would otherwise be accepted and
  // then measured against the wrong (180) limit, letting a 120-degree
  // "latitude" through.
  const hem = hemisphere.toUpperCase();
  const isLat = hem === "N" || hem === "S";
  const isLng = hem === "E" || hem === "W";
  if (!isLat && !isLng) return null;

  const decimal = (hem === "S" || hem === "W" ? -1 : 1) * (degrees + minutes / 60);
  return Math.abs(decimal) <= (isLat ? 90 : 180) ? decimal : null;
}

/** D0 `ddmmyy` + `hhmmss[.sss]` -> unix ms (UTC), or null if either is absent. */
function gpsInstant(date: string | undefined, time: string | undefined): number | null {
  if (!date || !time || !/^\d{6}$/.test(date) || !/^\d{6}(\.\d+)?$/.test(time)) return null;
  const dd = Number(date.slice(0, 2));
  const mo = Number(date.slice(2, 4));
  const yy = Number(date.slice(4, 6));
  const hh = Number(time.slice(0, 2));
  const mi = Number(time.slice(2, 4));
  const ss = Number(time.slice(4, 6));
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 60) return null;
  return Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss);
}

/**
 * Decode a structurally valid frame into a typed message. Every numeric field
 * is range-checked here: this is untrusted input off the public internet, and
 * a spoofed packet must not be able to push a nonsense voltage or an
 * out-of-range coordinate into the database.
 */
export function decodeMessage(frame: OmniFrame): DecodeResult {
  const p = frame.params;

  switch (frame.cmd) {
    case "Q0": {
      const voltageCv = inRange(int(p[0]), VOLTAGE_MIN_CV, VOLTAGE_MAX_CV);
      if (voltageCv === null) return { ok: false, reason: "bad_voltage" };
      return { ok: true, message: { type: "checkin", voltageCv } };
    }

    case "H0": {
      const lock = int(p[0]);
      const voltageCv = inRange(int(p[1]), VOLTAGE_MIN_CV, VOLTAGE_MAX_CV);
      const signal = inRange(int(p[2]), SIGNAL_MIN, SIGNAL_MAX);
      if (lock === null || (lock !== 0 && lock !== 1)) return { ok: false, reason: "bad_lock_status" };
      if (voltageCv === null) return { ok: false, reason: "bad_voltage" };
      if (signal === null) return { ok: false, reason: "bad_signal" };
      return { ok: true, message: { type: "heartbeat", locked: lock === 1, voltageCv, signal } };
    }

    case "S5": {
      const voltageCv = inRange(int(p[0]), VOLTAGE_MIN_CV, VOLTAGE_MAX_CV);
      const signal = inRange(int(p[1]), SIGNAL_MIN, SIGNAL_MAX);
      const satellites = inRange(int(p[2]), 0, MAX_SATELLITES);
      const lock = int(p[3]);
      if (voltageCv === null) return { ok: false, reason: "bad_voltage" };
      if (signal === null) return { ok: false, reason: "bad_signal" };
      if (satellites === null) return { ok: false, reason: "bad_satellites" };
      if (lock !== 0 && lock !== 1) return { ok: false, reason: "bad_lock_status" };
      return { ok: true, message: { type: "status", voltageCv, signal, satellites, locked: lock === 1 } };
    }

    case "D0": {
      // 13 fields (§1.3.5). An invalid fix still fills the arity with empties,
      // e.g. `D0,0,033724.00,V,,,,,,,120517,,,N` — that is a well-formed packet
      // reporting "no fix", not a malformed one.
      if (p.length < 13) return { ok: false, reason: "bad_position_arity" };
      const trackingFlag = int(p[0]);
      if (trackingFlag !== 0 && trackingFlag !== 1) return { ok: false, reason: "bad_tracking_flag" };
      const tracking = trackingFlag === 1;
      const valid = p[2].toUpperCase() === "A";
      if (!valid) return { ok: true, message: { type: "position", tracking, valid: false, fix: null } };

      // The hemisphere letters also say which axis each field is, so insist the
      // latitude field carries N/S and the longitude field E/W. Without this a
      // swapped or garbled packet could put a value up to 180 into `lat`.
      if (!/^[NS]$/i.test(p[4]) || !/^[EW]$/i.test(p[6])) {
        return { ok: false, reason: "bad_coordinates" };
      }
      const lat = nmeaToDecimal(p[3], p[4]);
      const lng = nmeaToDecimal(p[5], p[6]);
      if (lat === null || lng === null) return { ok: false, reason: "bad_coordinates" };
      return {
        ok: true,
        message: {
          type: "position",
          tracking,
          valid: true,
          fix: {
            lat, lng,
            satellites: inRange(int(p[7]), 0, MAX_SATELLITES),
            hdop: inRange(float(p[8]), 0, 100),
            altitudeM: inRange(float(p[10]), -1000, 20000),
            fixedAt: gpsInstant(p[9], p[1]),
          },
        },
      };
    }

    case "L0": {
      const result = int(p[0]);
      if (result !== 0 && result !== 1) return { ok: false, reason: "bad_unlock_result" };
      return {
        ok: true,
        message: { type: "unlockResult", success: result === 0, userId: p[1] ?? "", at: epochSeconds(p[2]) },
      };
    }

    case "L1":
      return {
        ok: true,
        message: {
          type: "lockReport",
          userId: p[0] ?? "",
          at: epochSeconds(p[1]),
          rideMinutes: inRange(int(p[2]), 0, 60 * 24 * 365),
        },
      };

    case "W0": {
      const code = inRange(int(p[0]), 0, 255);
      if (code === null) return { ok: false, reason: "bad_alarm_code" };
      return { ok: true, message: { type: "alarm", code } };
    }

    default:
      return { ok: true, message: { type: "other", cmd: frame.cmd, params: p } };
  }
}

/** §1.3.3/§1.3.4 timestamps are unix seconds (range 0..4294967295). */
function epochSeconds(value: string | undefined): number | null {
  const n = inRange(int(value), 0, 4294967295);
  return n === null ? null : n * 1000;
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

/** Appendix II: lithium voltage (0.01 V units) -> charge percentage. */
const BATTERY_CURVE: ReadonlyArray<readonly [cv: number, pct: number]> = [
  [340, 0], [355, 10], [359, 20], [362, 30], [364, 40], [370, 50],
  [376, 60], [383, 70], [391, 80], [401, 90], [412, 100],
];

/**
 * Map a reported voltage onto a 0-100 charge percentage, interpolating
 * linearly between the Appendix II reference points and clamping outside them.
 */
export function batteryPercent(voltageCv: number): number {
  const first = BATTERY_CURVE[0];
  const last = BATTERY_CURVE[BATTERY_CURVE.length - 1];
  if (voltageCv <= first[0]) return first[1];
  if (voltageCv >= last[0]) return last[1];
  for (let i = 1; i < BATTERY_CURVE.length; i++) {
    const [hiCv, hiPct] = BATTERY_CURVE[i];
    if (voltageCv > hiCv) continue;
    const [loCv, loPct] = BATTERY_CURVE[i - 1];
    return Math.round(loPct + ((voltageCv - loCv) / (hiCv - loCv)) * (hiPct - loPct));
  }
  return last[1];
}

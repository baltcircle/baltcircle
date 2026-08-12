import { describe, expect, it } from "vitest";
import {
  OMNI_PREFIX, OmniFramer, batteryPercent, buildAck, buildDevicePacket,
  buildServerPacket, decodeMessage, formatDeviceTimestamp, nmeaToDecimal,
  parseDeviceFrame, parseDeviceTimestamp,
} from "./protocol";

const IMEI = "123456789123456";

/** Parse a frame, failing the test if it is rejected. */
function frameOf(text: string) {
  const parsed = parseDeviceFrame(text);
  if (!parsed.ok) throw new Error(`expected a valid frame, got ${parsed.reason}`);
  return parsed.frame;
}

/** Decode a frame, failing the test if either stage rejects. */
function decode(text: string) {
  const decoded = decodeMessage(frameOf(text));
  if (!decoded.ok) throw new Error(`expected a decodable payload, got ${decoded.reason}`);
  return decoded.message;
}

describe("packet building", () => {
  it("prefixes server->lock packets with two literal 0xFF bytes and ends with #\\n", () => {
    const packet = buildServerPacket({ imei: IMEI, cmd: "S5", at: Date.UTC(2020, 2, 18, 12, 30, 20) });

    expect(packet.subarray(0, 2)).toEqual(Buffer.from(OMNI_PREFIX));
    expect(packet.subarray(2).toString("latin1")).toBe(`*CMDS,OM,${IMEI},200318123020,S5#\n`);
    // Appendix I's hex dump ends 23 0A — '#' then newline, not CRLF.
    expect(packet.subarray(-2)).toEqual(Buffer.from([0x23, 0x0a]));
  });

  it("serialises parameters in order", () => {
    const packet = buildServerPacket({
      imei: IMEI, cmd: "L0", params: [0, 1234, 1497689816], at: Date.UTC(2020, 2, 18, 12, 30, 20),
    });
    expect(packet.subarray(2).toString("latin1"))
      .toBe(`*CMDS,OM,${IMEI},200318123020,L0,0,1234,1497689816#\n`);
  });

  it("does not prefix lock->server packets", () => {
    const packet = buildDevicePacket({ imei: IMEI, cmd: "Q0", params: [412], at: Date.UTC(2020, 2, 18, 12, 30, 20) });
    expect(packet.toString("latin1")).toBe(`*CMDR,OM,${IMEI},200318123020,Q0,412#\n`);
  });

  it("rejects a non-15-digit IMEI rather than emitting a bad packet", () => {
    expect(() => buildServerPacket({ imei: "12345", cmd: "S5" })).toThrow(/invalid IMEI/);
  });

  it("acknowledges only the commands the protocol requires a response for", () => {
    for (const cmd of ["L0", "L1", "D0", "W0"]) {
      const ack = buildAck(IMEI, cmd, Date.UTC(2020, 2, 18, 12, 30, 20));
      expect(ack?.subarray(2).toString("latin1"))
        .toBe(`*CMDS,OM,${IMEI},200318123020,Re,${cmd}#\n`);
    }
    // §1.3.1 and §1.3.2 both state "No response".
    for (const cmd of ["Q0", "H0", "S5", "G0"]) {
      expect(buildAck(IMEI, cmd)).toBeNull();
    }
  });

  it("round-trips the yyMMddHHmmss clock field", () => {
    const at = Date.UTC(2020, 2, 18, 12, 30, 20);
    expect(formatDeviceTimestamp(at)).toBe("200318123020");
    expect(parseDeviceTimestamp("200318123020")).toBe(at);
  });

  it("treats the all-zero clock as unset rather than as year 2000", () => {
    // §1.4.3/§1.4.4 examples use 000000000000 for a device with no clock.
    expect(parseDeviceTimestamp("000000000000")).toBeNull();
    expect(parseDeviceTimestamp("201332123020")).toBeNull(); // month 13
    expect(parseDeviceTimestamp("notatime")).toBeNull();
  });
});

describe("frame parsing", () => {
  it("accepts the padding the vendor's own examples use", () => {
    // §1.3.1 writes "*CMDR ,OM,..." while §1.3.5 writes "*CMDR, OM, ...".
    const frame = frameOf(`*CMDR ,OM, ${IMEI}, 200318123020, Q0, 412#`);
    expect(frame.imei).toBe(IMEI);
    expect(frame.cmd).toBe("Q0");
    expect(frame.params).toEqual(["412"]);
  });

  it("rejects structurally invalid frames with a reason", () => {
    const cases: [string, string][] = [
      [`*CMDS,OM,${IMEI},200318123020,Q0,412#`, "wrong_direction"],
      [`*XXXX,OM,${IMEI},200318123020,Q0,412#`, "bad_header"],
      [`*CMDR,ZZ,${IMEI},200318123020,Q0,412#`, "bad_manufacturer"],
      [`*CMDR,OM,12345,200318123020,Q0,412#`, "bad_imei"],
      [`*CMDR,OM,12345678912345A,200318123020,Q0,412#`, "bad_imei"],
      [`*CMDR,OM,${IMEI},200318123020,QQQ,412#`, "bad_command"],
      [`*CMDR,OM,${IMEI},200318123020,Q0,412`, "missing_terminator"],
      [`CMDR,OM,${IMEI},200318123020,Q0,412#`, "missing_start"],
      [`*CMDR,OM,${IMEI}#`, "too_few_fields"],
    ];
    for (const [text, reason] of cases) {
      const parsed = parseDeviceFrame(text);
      expect(parsed.ok, `${text} should be rejected`).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe(reason);
    }
  });
});

describe("stream framing", () => {
  const a = `*CMDR,OM,${IMEI},200318123020,Q0,412#\n`;
  const b = `*CMDR,OM,${IMEI},200318123021,H0,1,412,28#\n`;

  it("reads one packet from one chunk", () => {
    const events = new OmniFramer().push(Buffer.from(a));
    expect(events).toEqual([{ kind: "frame", text: a.trim() }]);
  });

  it("reads several packets coalesced into one chunk", () => {
    const events = new OmniFramer().push(Buffer.from(a + b));
    expect(events.map((e) => e.kind === "frame" && e.text)).toEqual([a.trim(), b.trim()]);
  });

  it("reassembles a packet split across chunks, one byte at a time", () => {
    const framer = new OmniFramer();
    const bytes = Buffer.from(a);
    const seen: string[] = [];
    for (const byte of bytes) {
      for (const event of framer.push(Buffer.from([byte]))) {
        if (event.kind === "frame") seen.push(event.text);
      }
    }
    expect(seen).toEqual([a.trim()]);
  });

  it("handles a chunk boundary falling between the '#' and its newline", () => {
    const framer = new OmniFramer();
    const whole = a + b;
    const cut = a.length; // exactly after '#\n' of the first packet
    const first = framer.push(Buffer.from(whole.slice(0, cut - 1))); // withhold the \n
    const second = framer.push(Buffer.from(whole.slice(cut - 1)));
    expect(first.map((e) => e.kind === "frame" && e.text)).toEqual([a.trim()]);
    expect(second.map((e) => e.kind === "frame" && e.text)).toEqual([b.trim()]);
  });

  it("resynchronises past leading junk and a stray 0xFFFF prefix", () => {
    const framer = new OmniFramer();
    const chunk = Buffer.concat([Buffer.from([0xff, 0xff, 0x0d, 0x0a]), Buffer.from(a)]);
    expect(framer.push(chunk).map((e) => e.kind === "frame" && e.text)).toEqual([a.trim()]);
  });

  it("bounds the buffer when a peer never sends a terminator", () => {
    const framer = new OmniFramer(64);
    const events = framer.push(Buffer.from(`*${"A".repeat(200)}`));
    expect(events).toEqual([{ kind: "error", reason: "frame_overflow", bytes: 201 }]);
    expect(framer.pending).toBe(0);
  });

  it("bounds the buffer when a peer streams junk with no frame start", () => {
    const framer = new OmniFramer(64);
    const events = framer.push(Buffer.from("A".repeat(200)));
    expect(events).toEqual([{ kind: "error", reason: "junk_overflow", bytes: 200 }]);
  });
});

describe("payload decoding", () => {
  it("decodes a Q0 check-in", () => {
    expect(decode(`*CMDR,OM,${IMEI},200318123020,Q0,412#`)).toEqual({ type: "checkin", voltageCv: 412 });
  });

  it("rejects a voltage outside the documented 320-420 span", () => {
    for (const v of ["0", "319", "421", "9999", "abc", ""]) {
      const decoded = decodeMessage(frameOf(`*CMDR,OM,${IMEI},200318123020,Q0,${v}#`));
      expect(decoded.ok, `voltage ${v} should be rejected`).toBe(false);
    }
  });

  it("decodes an H0 heartbeat", () => {
    expect(decode(`*CMDR,OM,${IMEI},200318123020,H0,0,412,28#`))
      .toEqual({ type: "heartbeat", locked: false, voltageCv: 412, signal: 28 });
  });

  it("rejects an H0 signal outside 2-32", () => {
    expect(decodeMessage(frameOf(`*CMDR,OM,${IMEI},200318123020,H0,1,412,99#`)).ok).toBe(false);
  });

  it("decodes the S5 status response", () => {
    expect(decode(`*CMDR,OM,${IMEI},200318123020,S5,412,30,5,0,0#`))
      .toEqual({ type: "status", voltageCv: 412, signal: 30, satellites: 5, locked: false });
  });

  it("decodes the D0 position example from the specification", () => {
    // §1.3.5, including the vendor's irregular spacing. Note 3 gives the
    // expected WGS84 result: 22.62919 N, 114.14369 E.
    const message = decode(
      `*CMDR, OM, ${IMEI}, 200318123020,D0, 0,124458.00,A,2237.7514,N,11408.6214, E,6, 0.21, 151216,10, M,A#`,
    );
    expect(message.type).toBe("position");
    if (message.type !== "position" || !message.fix) throw new Error("expected a fix");

    expect(message.tracking).toBe(false);
    expect(message.valid).toBe(true);
    expect(message.fix.lat).toBeCloseTo(22.62919, 5);
    expect(message.fix.lng).toBeCloseTo(114.14369, 5);
    expect(message.fix.satellites).toBe(6);
    expect(message.fix.hdop).toBeCloseTo(0.21, 5);
    expect(message.fix.altitudeM).toBe(10);
    // utcDate ddmmyy=151216 + utcTime hhmmss=124458 -> 2016-12-15T12:44:58Z
    expect(message.fix.fixedAt).toBe(Date.UTC(2016, 11, 15, 12, 44, 58));
  });

  it("treats the documented invalid-fix report as valid framing with no position", () => {
    // §1.3.5 note 2 — empty coordinate fields, status V.
    const message = decode(`*CMDR,OM,${IMEI},200318123020,D0,0,033724.00,V,,,,,,,120517,,,N#`);
    expect(message).toEqual({ type: "position", cmd: "D0", tracking: false, valid: false, fix: null });
  });

  it("flags a tracking-mode position report", () => {
    const message = decode(
      `*CMDR,OM,${IMEI},200318123020,D0,1,124458.00,A,2237.7514,N,11408.6214,E,6,0.21,151216,10,M,A#`,
    );
    expect(message.type === "position" && message.tracking).toBe(true);
  });

  it("accepts a D1 GPS-shaped tracking upload as a position", () => {
    const message = decode(
      `*CMDR,OM,${IMEI},200318123020,D1,1,124458.00,A,2237.7514,N,11408.6214,E,6,0.21,151216,10,M,A#`,
    );
    expect(message.type).toBe("position");
    expect(message.type === "position" && message.cmd).toBe("D1");
  });

  it("rejects a D0 with too few fields or impossible coordinates", () => {
    expect(decodeMessage(frameOf(`*CMDR,OM,${IMEI},200318123020,D0,0,124458.00,A#`)).ok).toBe(false);
    expect(decodeMessage(frameOf(
      `*CMDR,OM,${IMEI},200318123020,D0,0,124458.00,A,9937.7514,N,11408.6214,E,6,0.21,151216,10,M,A#`,
    )).ok).toBe(false);
  });

  it("rejects a D0 whose hemisphere letters do not match their axis", () => {
    // Latitude carrying E would otherwise be range-checked against 180 and let
    // a 120-degree "latitude" reach the database.
    for (const [latHem, lngHem] of [["E", "E"], ["N", "N"], ["", "E"], ["N", ""]]) {
      const frame = `*CMDR,OM,${IMEI},200318123020,D0,0,124458.00,A,` +
        `2237.7514,${latHem},11408.6214,${lngHem},6,0.21,151216,10,M,A#`;
      expect(decodeMessage(frameOf(frame)).ok, `hemispheres ${latHem}/${lngHem}`).toBe(false);
    }
  });

  it("decodes unlock results, lock reports and alarms", () => {
    expect(decode(`*CMDR,OM,${IMEI},200318123020,L0,0,1234,1497689816#`))
      .toEqual({ type: "unlockResult", success: true, userId: "1234", at: 1497689816_000 });
    expect(decode(`*CMDR,OM,${IMEI},200318123020,L1,1234,1497689816,3#`))
      .toEqual({ type: "lockReport", userId: "1234", at: 1497689816_000, rideMinutes: 3 });
    expect(decode(`*CMDR,OM,${IMEI},200318123020,W0,1#`)).toEqual({ type: "alarm", code: 1 });
  });

  it("decodes lock registry metadata without breaking auxiliary commands", () => {
    expect(decode(`*CMDR,OM,${IMEI},200318123020,I0,123456789AB123456789#`))
      .toEqual({ type: "iccid", simIccid: "123456789AB123456789" });
    expect(decode(`*CMDR,OM,${IMEI},200318123020,G0,XX_110,Jul 4 2018#`))
      .toEqual({ type: "firmware", deviceTypeCode: "XX", firmwareVersion: "110" });
    expect(decode(`*CMDR,OM,${IMEI},200318123020,U0,A1,110,1101#`))
      .toEqual({ type: "other", cmd: "U0", params: ["A1", "110", "1101"] });
  });
});

describe("coordinate conversion", () => {
  it("converts NMEA ddmm.mmmm / dddmm.mmmm to signed degrees", () => {
    expect(nmeaToDecimal("2237.7514", "N")).toBeCloseTo(22.62919, 5);
    expect(nmeaToDecimal("11408.6214", "E")).toBeCloseTo(114.14369, 5);
    expect(nmeaToDecimal("2237.7514", "S")).toBeCloseTo(-22.62919, 5);
    expect(nmeaToDecimal("11408.6214", "W")).toBeCloseTo(-114.14369, 5);
  });

  it("handles the Baltic coordinates this fleet actually operates in", () => {
    // Svetlogorsk, 54.9442 N 20.1561 E -> 5456.652 N, 02009.366 E
    expect(nmeaToDecimal("5456.6520", "N")).toBeCloseTo(54.94420, 4);
    expect(nmeaToDecimal("02009.3660", "E")).toBeCloseTo(20.15610, 4);
  });

  it("rejects malformed or out-of-range coordinates", () => {
    expect(nmeaToDecimal("2237.7514", "X")).toBeNull();
    expect(nmeaToDecimal("abcd.efgh", "N")).toBeNull();
    expect(nmeaToDecimal("2277.7514", "N")).toBeNull(); // 77 minutes
    expect(nmeaToDecimal("9937.7514", "N")).toBeNull(); // 99 degrees latitude
  });

  it("requires exactly one hemisphere letter", () => {
    // A substring test against "NSEW" would accept all of these, and then
    // measure a latitude against the 180 longitude limit.
    for (const hemisphere of ["", "NS", "SE", "EW", "NSEW", "N ", "NN"]) {
      expect(nmeaToDecimal("12000.0000", hemisphere), `hemisphere ${JSON.stringify(hemisphere)}`)
        .toBeNull();
    }
  });
});

describe("battery curve", () => {
  it("matches the Appendix II reference points", () => {
    const table: [number, number][] = [
      [412, 100], [401, 90], [391, 80], [383, 70], [376, 60],
      [370, 50], [364, 40], [362, 30], [359, 20], [355, 10], [340, 0],
    ];
    for (const [cv, pct] of table) expect(batteryPercent(cv)).toBe(pct);
  });

  it("interpolates between reference points and clamps outside them", () => {
    expect(batteryPercent(396)).toBe(85); // midway between 391 (80) and 401 (90)
    expect(batteryPercent(300)).toBe(0);
    expect(batteryPercent(500)).toBe(100);
  });
});

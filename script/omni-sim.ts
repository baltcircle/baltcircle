// Manual smoke tool: run one or more simulated OMNI locks against a live ingest
// server, without any hardware.
//
// The automated coverage lives in server/omni/server.test.ts; this exists for
// eyeballing the real process end to end — watching its logs, seeing rows land
// in bike_telemetry, checking the ops map moves. It reuses the same MockLock the
// tests use, so what it puts on the wire is what a lock puts on the wire.
//
// The IMEIs must already be registered on bikes.lock_imei, otherwise the server
// will (correctly) hang up on them:
//   UPDATE bikes SET lock_imei = '861234567890123' WHERE id = 'BC-001';
//
// Usage:
//   npm run omni:sim -- --imei 861234567890123
//   npm run omni:sim -- --imei 861234567890123,861234567890124 --port 5100 \
//     --interval 5000 --lat 54.9442 --lng 20.1561
import { MockLock } from "../server/omni/mockLock";

interface Args {
  imeis: string[];
  host: string;
  port: number;
  intervalMs: number;
  lat: number;
  lng: number;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key && argv[i + 1] !== undefined) flags.set(key, argv[i + 1]);
  }
  const num = (name: string, fallback: number) => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${raw}`);
    return n;
  };

  const imeis = (flags.get("imei") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (imeis.length === 0) throw new Error("--imei <15 digits[,...]> is required");
  for (const imei of imeis) {
    if (!/^\d{15}$/.test(imei)) throw new Error(`not a 15-digit IMEI: ${imei}`);
  }

  return {
    imeis,
    host: flags.get("host") ?? "127.0.0.1",
    port: num("port", Number(process.env.OMNI_TCP_PORT) || 5100),
    intervalMs: num("interval", 10_000),
    // Central Svetlogorsk, inside the operating zone this fleet runs in.
    lat: num("lat", 54.9442),
    lng: num("lng", 20.1561),
  };
}

/** A slow wander around the start point, so the map shows a track rather than a dot. */
function drift(base: number, step: number): number {
  return base + Math.sin(step / 6) * 0.0012;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const locks: MockLock[] = [];

  for (const imei of args.imeis) {
    const lock = new MockLock({ imei, host: args.host, port: args.port });
    await lock.connect();
    locks.push(lock);
    console.log(`[${imei}] connected to ${args.host}:${args.port}`);
    lock.sendCheckin();
  }

  let step = 0;
  const timer = setInterval(() => {
    step++;
    for (const lock of locks) {
      // Roughly the real cadence pattern: a position every tick, a heartbeat
      // every third, a battery check-in every sixth.
      lock.sendPosition(drift(args.lat, step), drift(args.lng, step + 3), { tracking: true });
      if (step % 3 === 0) lock.sendHeartbeat(false);
      if (step % 6 === 0) lock.sendCheckin();

      const acks = lock.received.length;
      console.log(`[${lock.imei}] step ${step}, ${acks} server command(s) received`);
    }
  }, args.intervalMs);

  const stop = () => {
    clearInterval(timer);
    for (const lock of locks) lock.disconnect();
    console.log("simulated locks disconnected");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

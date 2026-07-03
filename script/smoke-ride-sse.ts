// Smoke test for the active-ride SSE stream (P2.7) and the bikes read cache
// (P2.8). Boots the real Express server against a throwaway Postgres DB, then:
//   1. registers a rider via the OTP dev fallback to obtain a session cookie
//   2. opens GET /api/rides/active/stream and reads the initial frame (null)
//   3. starts a ride  -> asserts a frame with the active ride is pushed
//   4. appends a point -> asserts a frame reflecting the moved position
//   5. ends the ride   -> asserts a terminal null frame
//   6. confirms the bikes cache serves a bike as "rented" during the ride and
//      "available" again after it ends (invalidation works)
//
// Run with:  npx tsx script/smoke-ride-sse.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown } from "./smoke-pg";

const NAME = "ride-sse";
const PORT = 5602;
const BASE = `http://127.0.0.1:${PORT}`;

let DB_URL = "";
let server: ChildProcess;

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`\u2717 ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`\u2713 ${msg}`);
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/bikes`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Server did not start in time");
}

function cookieFromSetCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

// A minimal SSE reader over fetch's ReadableStream. Collects complete "data:"
// frames into a queue and lets the test await the next one with a timeout.
class SseReader {
  private buf = "";
  private frames: string[] = [];
  private waiters: Array<(f: string) => void> = [];
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
    void this.pump();
  }

  private emit(frame: string) {
    const w = this.waiters.shift();
    if (w) w(frame);
    else this.frames.push(frame);
  }

  private async pump() {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) return;
        this.buf += this.decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let idx: number;
        while ((idx = this.buf.indexOf("\n\n")) !== -1) {
          const raw = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 2);
          const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
          if (dataLine) this.emit(dataLine.slice("data:".length).trim());
        }
      }
    } catch {
      // stream closed
    }
  }

  next(timeoutMs = 5000): Promise<string> {
    const existing = this.frames.shift();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("SSE frame timeout")), timeoutMs);
      this.waiters.push((f) => {
        clearTimeout(t);
        resolve(f);
      });
    });
  }

  cancel() {
    void this.reader.cancel().catch(() => {});
  }
}

async function bikeStatus(id: string): Promise<string | undefined> {
  const res = await fetch(`${BASE}/api/bikes`);
  const bikes = (await res.json()) as Array<{ id: string; status: string }>;
  return bikes.find((b) => b.id === id)?.status;
}

async function main() {
  DB_URL = (await createTestDb(NAME)).url;
  server = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
    {
      env: { ...process.env, NODE_ENV: "development", API_ONLY: "1", PORT: String(PORT), DATABASE_URL: DB_URL, SMS_PROVIDER: "" },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  await waitForServer();

  // --- Register a rider (OTP dev fallback) ---
  let res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Тест Гонщик", phone: "89002223344", consent: true }),
  });
  assert(res.status === 200, "OTP start returns 200");
  const startBody = await res.json();
  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: startBody.phone, code: startBody.devCode }),
  });
  assert(res.status === 201, "OTP verify returns 201");
  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"))!;
  assert(!!cookie, "session cookie obtained");

  // Pick an available bike from the cached list.
  const bikesRes = await fetch(`${BASE}/api/bikes`);
  const bikes = (await bikesRes.json()) as Array<{ id: string; status: string }>;
  const bike = bikes.find((b) => b.status === "available")!;
  assert(!!bike, "an available bike exists in the list");

  // --- Open the SSE stream ---
  const streamRes = await fetch(`${BASE}/api/rides/active/stream`, {
    headers: { cookie, accept: "text/event-stream" },
  });
  assert(streamRes.status === 200, "SSE stream returns 200");
  assert(
    (streamRes.headers.get("content-type") ?? "").includes("text/event-stream"),
    "SSE stream has text/event-stream content type",
  );
  const sse = new SseReader(streamRes.body!);

  // 2. Initial frame: no active ride yet.
  const f0 = await sse.next();
  assert(f0 === "null", "initial SSE frame is null (no active ride)");

  // Top up the wallet so the internal (non-prepaid) ride debit succeeds.
  res = await fetch(`${BASE}/api/wallet/topup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ amount: 1000 }),
  });
  assert(res.status === 200, "wallet topup returns 200");

  // 3. Start a ride -> a frame with the active ride is pushed.
  res = await fetch(`${BASE}/api/rides/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ bikeId: bike.id, tariff: "h1" }),
  });
  const ride = await res.json();
  assert(res.status === 200, `ride start returns 200 (got ${res.status}: ${JSON.stringify(ride)})`);
  const rideId = ride.id;

  const f1 = JSON.parse(await sse.next());
  assert(f1 && f1.id === rideId && f1.status === "active", "SSE pushed active ride after start");
  assert((await bikeStatus(bike.id)) === "rented", "bikes cache shows bike rented after start (invalidated)");

  // 4. Append a point -> a frame reflecting the new position is pushed.
  res = await fetch(`${BASE}/api/rides/${rideId}/point`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ x: 500, y: 500 }),
  });
  assert(res.status === 200, "append point returns 200");
  const f2 = JSON.parse(await sse.next());
  assert(f2 && f2.id === rideId && f2.status === "active", "SSE pushed updated active ride after point");

  // 5. End the ride -> terminal null frame.
  res = await fetch(`${BASE}/api/rides/${rideId}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
  });
  assert(res.status === 200, "ride end returns 200");
  const f3 = await sse.next();
  assert(f3 === "null", "SSE pushed null after ride end");
  assert((await bikeStatus(bike.id)) === "available", "bikes cache shows bike available after end (invalidated)");

  sse.cancel();
  console.log("\nride-sse smoke passed");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown(NAME, server);
  });

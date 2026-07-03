// Smoke test for the admin rides management API.
//
// Boots the real Express server against a throwaway SQLite DB with the dev SMS
// fallback (codes echoed) and ADMIN_PHONE_NUMBERS set. Then:
//   1. registers an admin and a plain rider
//   2. asserts /api/admin/rides requires staff (401 unauth, 403 rider)
//   3. has the rider start a ride, then asserts it shows up in the admin list
//      with the rider's name/phone attached and status "active"
//   4. asserts a non-staff caller can't end a ride (403)
//   5. has the admin end the rider's active ride → 200, status "completed"
//   6. asserts ending an already-finished/unknown ride returns 404
//
// Run with:  npx tsx script/smoke-admin-rides.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown } from "./smoke-pg";

const PORT = 5604;
const NAME = "admin-rides";
let DB_URL = "";
let server: ChildProcess;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PHONE = "+79991112266";


function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
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

async function register(name: string, phone: string): Promise<{ cookie: string; user: any }> {
  let res = await fetch(`${BASE}/api/auth/otp/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, phone, consent: true }),
  });
  if (res.status !== 200) throw new Error(`otp/start failed for ${phone}: ${res.status}`);
  const start = await res.json();
  res = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: start.phone, code: start.devCode }),
  });
  if (res.status !== 201) throw new Error(`otp/verify failed for ${phone}: ${res.status}`);
  const user = await res.json();
  const cookie = cookieFromSetCookie(res.headers.get("set-cookie"))!;
  return { cookie, user };
}

function startServer(): ChildProcess {
  return spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "server/index.ts"],
  {
    env: {
      ...process.env,
      NODE_ENV: "development",
      API_ONLY: "1",
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      SMS_PROVIDER: "",
      ADMIN_PHONE_NUMBERS: ADMIN_PHONE,
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
  );
}

const j = (cookie: string, method: string, url: string, body?: any) =>
  fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function main() {
  DB_URL = (await createTestDb(NAME)).url;
  server = startServer();
  await waitForServer();

  const admin = await register("Админ", ADMIN_PHONE);
  assert(admin.user.role === "admin", "admin phone is promoted to role=admin");
  const rider = await register("Райдер Тест", "+79005550033");
  assert(rider.user.role === "rider", "ordinary phone registers as role=rider");

  // 2. Access control on the list endpoint.
  let res = await fetch(`${BASE}/api/admin/rides`);
  assert(res.status === 401, "GET /api/admin/rides without session returns 401");
  res = await fetch(`${BASE}/api/admin/rides`, { headers: { cookie: rider.cookie } });
  assert(res.status === 403, "rider cannot list admin rides (403)");

  // 3. Rider starts a ride on a seeded available bike.
  const bikes = await (await fetch(`${BASE}/api/bikes`)).json();
  const available = bikes.find((b: any) => b.status === "available");
  assert(!!available, "a seeded available bike exists to rent");
  // Hourly prepaid model: internal start debits the tariff price at start,
  // so the rider needs funds and must pick a valid hourly tariff (h1/h2/h3).
  res = await j(rider.cookie, "POST", "/api/wallet/topup", { amount: 1000 });
  assert(res.status === 200, "rider tops up wallet (200)");
  res = await j(rider.cookie, "POST", "/api/rides/start", { bikeId: available.id, tariff: "h1" });
  assert(res.status === 200, "rider starts a ride (200)");
  const ride = await res.json();
  assert(ride.status === "active", "started ride is active");
  const startTrack = JSON.parse(ride.track) as [number, number, number][];
  assert(startTrack.length >= 1, "fresh ride has a seed track point");

  // Append-only GPS points: each /point is a single INSERT into ride_points,
  // and the returned ride hydrates its live track from that table. Sending two
  // points must grow the track and increase the accumulated distance.
  const p0 = startTrack[startTrack.length - 1];
  res = await j(rider.cookie, "POST", `/api/rides/${ride.id}/point`, { x: p0[0] + 10, y: p0[1] + 10 });
  assert(res.status === 200, "rider appends GPS point #1 (200)");
  const afterP1 = await res.json();
  const trackP1 = JSON.parse(afterP1.track) as [number, number, number][];
  assert(trackP1.length === startTrack.length + 1, "track grows by one after point #1");
  assert(afterP1.distanceM > ride.distanceM, "distance increases after point #1");
  res = await j(rider.cookie, "POST", `/api/rides/${ride.id}/point`, { x: p0[0] + 20, y: p0[1] + 20 });
  assert(res.status === 200, "rider appends GPS point #2 (200)");
  const afterP2 = await res.json();
  const trackP2 = JSON.parse(afterP2.track) as [number, number, number][];
  assert(trackP2.length === startTrack.length + 2, "track grows by two after point #2");
  assert(afterP2.distanceM > afterP1.distanceM, "distance increases after point #2");

  // getActiveRide must hydrate the same live track from ride_points.
  res = await fetch(`${BASE}/api/rides/active`, { headers: { cookie: rider.cookie } });
  assert(res.status === 200, "rider reads active ride (200)");
  const activeRide = await res.json();
  const activeTrack = JSON.parse(activeRide.track) as [number, number, number][];
  assert(activeTrack.length === startTrack.length + 2, "active ride reflects all appended points");

  // Admin list shows the ride with rider identity attached.
  res = await fetch(`${BASE}/api/admin/rides`, { headers: { cookie: admin.cookie } });
  assert(res.status === 200, "admin can list rides (200)");
  const list = await res.json();
  const found = list.find((r: any) => r.id === ride.id);
  assert(!!found, "the new ride appears in the admin list");
  assert(found.userName === "Райдер Тест", "ride row carries the rider's name");
  assert(found.userPhone === rider.user.phone, "ride row carries the rider's phone");
  assert(found.status === "active", "ride row reports active status");

  // 4. Non-staff cannot end a ride.
  res = await j(rider.cookie, "POST", `/api/admin/rides/${ride.id}/end`, {});
  assert(res.status === 403, "rider cannot end a ride via admin endpoint (403)");
  res = await fetch(`${BASE}/api/admin/rides/${ride.id}/end`, { method: "POST" });
  assert(res.status === 401, "unauthenticated end attempt returns 401");

  // 5. Admin ends the active ride.
  res = await j(admin.cookie, "POST", `/api/admin/rides/${ride.id}/end`, {});
  assert(res.status === 200, "admin ends the active ride (200)");
  const ended = await res.json();
  assert(ended.status === "completed", "ended ride is marked completed");
  assert(typeof ended.endedAt === "number" && ended.endedAt > 0, "ended ride has an end timestamp");

  // The freed bike returns to the public list as available.
  const afterBikes = await (await fetch(`${BASE}/api/bikes`)).json();
  const freed = afterBikes.find((b: any) => b.id === available.id);
  assert(freed && freed.status === "available", "bike is freed back to available after admin end");

  // 6. Ending again (no longer active) or an unknown ride → 404.
  res = await j(admin.cookie, "POST", `/api/admin/rides/${ride.id}/end`, {});
  assert(res.status === 404, "ending an already-finished ride returns 404");
  res = await j(admin.cookie, "POST", "/api/admin/rides/999999/end", {});
  assert(res.status === 404, "ending an unknown ride returns 404");

  console.log("\nAll admin rides smoke checks passed.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown(NAME, server);
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });

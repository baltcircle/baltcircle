// Smoke test for clean-URL (pretty path) SPA routing.
//
// With hash routing removed, deep links like /profile or /bike/BC-001 are real
// paths the browser requests directly on refresh/open. The Express server must
// serve index.html for any non-API route (SPA fallback) while keeping /api/*
// working. This boots the PRODUCTION server against the built client and checks
// both halves.
//
// Requires a prior `npm run build` (serveStatic reads dist/public). Run with:
//   npm run build && npx tsx script/smoke-spa-fallback.ts
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb, teardown } from "./smoke-pg";

const PORT = 5611;
const BASE = `http://127.0.0.1:${PORT}`;
const NAME = "spa-fallback";
let DB_URL = "";
let server: ChildProcess;
const DIST_INDEX = path.resolve("dist/public/index.html");

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`✓ ${msg}`);
}

assert(existsSync(DIST_INDEX), "dist/public/index.html exists (run npm run build first)");

function startServer(): ChildProcess {
  return spawn(process.execPath, ["dist/index.cjs"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), DATABASE_URL: DB_URL, SMS_PROVIDER: "", SESSION_SECRET: "smoke-spa-fallback-test-secret" },
    stdio: ["ignore", "ignore", "inherit"],
  });
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

async function stop(proc: ChildProcess) {
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
}

async function main() {
  DB_URL = (await createTestDb(NAME)).url;
  server = startServer();
  await waitForServer();

  // The index.html the SPA fallback should serve, for byte comparison.
  const indexHtml = await (await fetch(`${BASE}/`)).text();
  assert(indexHtml.includes('<div id="root">'), "root path serves the SPA index.html");

  // Clean deep paths must all serve the same SPA shell (200 + index.html), so a
  // direct refresh/open on any route boots the client router rather than 404ing.
  const deepPaths = [
    "/profile",
    "/settings",
    "/admin",
    "/admin/bikes",
    "/admin/users",
    "/admin/rides",
    "/admin/parkings",
    "/admin/operations-map",
    "/bike/BC-001",
    "/legal/privacy",
  ];
  for (const p of deepPaths) {
    const res = await fetch(`${BASE}${p}`);
    const body = await res.text();
    assert(res.status === 200, `GET ${p} returns 200`);
    assert(body === indexHtml, `GET ${p} serves the SPA index.html (fallback)`);
  }

  // API routes must NOT be swallowed by the fallback — they return JSON.
  const apiRes = await fetch(`${BASE}/api/bikes`);
  assert(apiRes.status === 200, "GET /api/bikes returns 200");
  const ct = apiRes.headers.get("content-type") ?? "";
  assert(ct.includes("application/json"), "GET /api/bikes returns JSON (not the SPA shell)");
  const bikes = await apiRes.json();
  assert(Array.isArray(bikes), "GET /api/bikes returns a JSON array");

  console.log("\nAll SPA-fallback / clean-URL smoke checks passed.");
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

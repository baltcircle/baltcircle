// Entry point for the OMNI lock TCP ingest process.
//
// Runs independently of the Express API (server/index.ts): the locks hold
// persistent sockets, so a web deploy must not disconnect the fleet, and a lock
// firmware issue must not take down the website. Both processes share the same
// database and the same schema bootstrap.
//
// Device-side network config (IP, port, APN) is flashed on the lock itself —
// over BLE for the sample units, at the factory for a bulk order — so nothing
// about a specific endpoint is hardcoded here. All this process decides is
// which local port to accept on.
import "dotenv/config";
import { bootstrapReady, pool } from "../db/bootstrap";
import { logger } from "../logger";
import { OmniTcpServer } from "./server";
import { PgOmniStore } from "./store";
import { setLockGateway } from "./gateway";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    logger.warn({ name, raw }, "invalid integer env var, using default");
    return fallback;
  }
  return n;
}

async function main(): Promise<void> {
  // The schema bootstrap is idempotent and shared with the API process; whoever
  // starts first creates the tables.
  await bootstrapReady;

  const server = new OmniTcpServer({
    store: new PgOmniStore(),
    logger,
    port: envInt("LOCK_GATEWAY_PORT", 5100),
    host: process.env.LOCK_GATEWAY_HOST || "0.0.0.0",
    maxConnections: envInt("OMNI_MAX_CONNECTIONS", 500),
    idleTimeoutMs: envInt("OMNI_IDLE_TIMEOUT_MS", 15 * 60_000),
    statusMinIntervalMs: envInt("OMNI_STATUS_MIN_INTERVAL_MS", 60_000),
    writer: {
      flushIntervalMs: envInt("OMNI_FLUSH_INTERVAL_MS", 2_000),
      maxBatchRows: envInt("OMNI_MAX_BATCH_ROWS", 500),
    },
  });

  await server.listen();
  setLockGateway(server);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down OMNI TCP server");
    try {
      // close() flushes buffered telemetry before the process exits, so a
      // deploy does not lose the last few seconds of reports.
      await server.close();
      setLockGateway(null);
      await pool.end();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A lock connection must never be able to kill the process; log loudly and
  // keep the remaining fleet connected.
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
  process.on("uncaughtException", (err) => logger.error({ err }, "uncaught exception"));
}

main().catch((err) => {
  logger.error({ err }, "OMNI TCP server failed to start");
  process.exit(1);
});

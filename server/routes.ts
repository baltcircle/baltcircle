import type { Express } from "express";
import type { Server } from "node:http";
import { registerAuthRoutes } from "./http/auth";
import { registerPaymentRoutes } from "./http/payments";
import { registerSupportTicketRoutes } from "./http/tickets";
import { registerAdminUserRoutes } from "./http/admin";
import { registerCatalogRoutes } from "./http/catalog";
import { registerRideRoutes } from "./http/rides";
import { registerWalletRoutes } from "./http/wallet";
import { registerServiceTicketRoutes } from "./http/service";
import { registerMapRoutes } from "./http/map";
import { registerTileRoutes } from "./http/tiles";

// Thin aggregator: the API is split into per-domain route modules under
// server/http/*, each exporting a register<Domain>Routes(app) function that
// binds its endpoints. Shared middleware/helpers live in server/http/context.
// Registration order preserves the original single-file order so route-shadowing
// behaviour (e.g. specific paths before parameterised ones) is unchanged.
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  registerAuthRoutes(app);
  registerPaymentRoutes(app);
  registerSupportTicketRoutes(app);
  registerAdminUserRoutes(app);
  registerCatalogRoutes(app);
  registerRideRoutes(app);
  registerWalletRoutes(app);
  registerServiceTicketRoutes(app);
  registerMapRoutes(app);
  registerTileRoutes(app);
  return httpServer;
}

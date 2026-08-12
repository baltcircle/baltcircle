// Process-local gateway registry used by the administrative control surface.
// The production TCP entrypoint registers the live instance at startup; keeping
// this tiny module separate avoids a circular dependency between HTTP routes
// and the net.Server implementation.
import type { OmniTcpServer } from "./server";

let gateway: OmniTcpServer | null = null;

export function setLockGateway(instance: OmniTcpServer | null): void {
  gateway = instance;
}

export function getLockGateway(): OmniTcpServer | null {
  return gateway;
}


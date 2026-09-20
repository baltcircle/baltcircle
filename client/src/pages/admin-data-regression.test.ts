import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("admin UI recovery wiring", () => {
  it("requests paged server results in all growing lists", () => {
    for (const path of ["./UsersPage.tsx", "./RidesAdminPage.tsx", "./FeedbackAdminPage.tsx"]) {
      expect(source(path)).toContain("useAdminPage");
      expect(source(path)).not.toContain("useClientPagination");
    }
  });
  it("uses the independent unbounded active-rides endpoint for the map", () => {
    expect(source("./OperationsMapPage.tsx")).toContain('"/api/admin/rides", "active"');
  });
  it("does not report green before successful alert retrieval", () => {
    expect(source("./AdminPage.tsx")).toContain("fleetAlertsQ.isSuccess");
    expect(source("./AdminPage.tsx")).toContain("/api/admin/ride-stats");
  });
  it("recovers chat history on connection and polls as a fallback", () => {
    const chat = source("./support-chats/AdminChatPanel.tsx");
    expect(chat).toContain("es.onopen");
    expect(chat).toContain("refetchInterval: 30_000");
  });
  it("uses hierarchical ticket detail keys", () => {
    expect(source("./maintenance/TicketDetail.tsx")).toContain('queryKey: ["/api/tickets", id]');
  });
  it("refreshes relative analytic dates and live duration without HTTP timers", () => {
    expect(source("./AnalyticsPage.tsx")).toContain("useClock");
    expect(source("./RidesAdminPage.tsx")).toContain("useClock");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { affectedByTopics, refreshAdminData } from "./admin-freshness";

afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); });

describe("admin freshness", () => {
  it.each(["/api/admin/users", "/api/admin/feedback", "/api/admin/analytics", "/api/tickets"])(
    "reopens stale %s with a real fetch", async (path) => {
      queryClient.setQueryData([path], { version: 1 }, { updatedAt: Date.now() - 61_000 });
      const fetch = vi.fn().mockResolvedValue({ version: 2 });
      const observer = new QueryObserver(queryClient, { queryKey: [path], queryFn: fetch });
      const stop = observer.subscribe(() => {});
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      stop();
    },
  );
  it("refreshes only active enabled operational queries, not rider/account data", async () => {
    const adminFetch = vi.fn().mockResolvedValue([]);
    const riderFetch = vi.fn().mockResolvedValue([]);
    queryClient.setQueryData(["/api/admin/users"], [], { updatedAt: 1 });
    queryClient.setQueryData(["/api/payment-methods"], [], { updatedAt: 1 });
    const a = new QueryObserver(queryClient, { queryKey: ["/api/admin/users"], queryFn: adminFetch, staleTime: Infinity });
    const b = new QueryObserver(queryClient, { queryKey: ["/api/payment-methods"], queryFn: riderFetch, refetchOnMount: false });
    const stopA = a.subscribe(() => {}), stopB = b.subscribe(() => {});
    await refreshAdminData(queryClient);
    expect(adminFetch).toHaveBeenCalledOnce();
    expect(riderFetch).not.toHaveBeenCalled();
    stopA(); stopB();
  });
  it("covers dependent ratings, metrics and nested ticket detail keys", () => {
    expect(affectedByTopics(["/api/admin/users", { page: 1 }], ["feedback"])).toBe(true);
    expect(affectedByTopics(["/api/admin/rides", "page", {}], ["feedback"])).toBe(true);
    expect(affectedByTopics(["/api/tickets", 42], ["service"])).toBe(true);
    expect(affectedByTopics(["/api/admin/ride-stats"], ["rides"])).toBe(true);
    expect(affectedByTopics(["/api/payment-methods"], ["users"])).toBe(false);
  });
});

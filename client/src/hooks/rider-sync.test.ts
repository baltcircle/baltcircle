import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { queryClient, acceptSessionUser, getQueryFn, apiRequest, resetSessionData } from "@/lib/queryClient";
import { useActiveRideStream } from "./use-active-ride-stream";
import { useFleetStream } from "./use-fleet-stream";
import { openLiveStream } from "@/lib/live-stream";

const harness = vi.hoisted(() => ({
  effects: [] as { callback: () => void | (() => void); deps: unknown[] }[],
}));
vi.mock("react", async (original) => ({
  ...(await original()),
  useEffect: (callback: () => void | (() => void), deps: unknown[]) => harness.effects.push({ callback, deps }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original()), useQueryClient: () => queryClient,
}));
vi.mock("./use-current-user", () => ({
  useCurrentUser: () => ({ user: queryClient.getQueryData(["/api/users/current"]) }),
}));
class FakeStream {
  static instances: FakeStream[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, () => void>();
  closed = false;
  constructor(public url: string) { FakeStream.instances.push(this); }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn); }
  close() { this.closed = true; }
}
let cleanups: (() => void)[] = [];
beforeEach(() => {
  queryClient.clear();
  harness.effects = [];
  FakeStream.instances = [];
  cleanups = [];
  vi.stubGlobal("EventSource", FakeStream);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  cleanups.reverse().forEach((fn) => fn());
  queryClient.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mount() {
  for (const effect of harness.effects.splice(0)) {
    const cleanup = effect.callback();
    if (cleanup) cleanups.push(cleanup);
  }
}
describe("rider data freshness regressions", () => {
  it.each(["/api/rider/history", "/api/rider/stats", "/api/support/chat", "/api/map-objects",
    "/api/reservations/active", "/api/payment-methods"])("%s revalidates on reopening, focus and reconnect", async (path) => {
    const queryKey = [path];
    const queryFn = vi.fn().mockResolvedValue(["old"]);
    await queryClient.fetchQuery({ queryKey, queryFn });
    queryFn.mockResolvedValue(["new"]);
    const observer = new QueryObserver(queryClient, { queryKey, queryFn });
    const unsubscribe = observer.subscribe(() => {});
    cleanups.push(unsubscribe);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(["new"]));
    const q = queryClient.getQueryCache().find({ queryKey })!;
    queryFn.mockClear();
    q.onFocus();
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(q.state.fetchStatus).toBe("idle"));
    queryFn.mockClear();
    q.onOnline();
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledOnce());
  });
  it("does not create a private guest SSE and binds the logged-in identity", () => {
    queryClient.setQueryData(["/api/users/current"], null);
    useActiveRideStream();
    mount();
    expect(FakeStream.instances).toHaveLength(0);
    queryClient.setQueryData(["/api/users/current"], { id: "rider" });
    useActiveRideStream();
    expect(harness.effects[0].deps).toContain("rider");
    mount();
    expect(FakeStream.instances).toHaveLength(1);
  });
  it("invalidates history and totals on async end, not GPS-only updates", () => {
    queryClient.setQueryData(["/api/users/current"], { id: "rider" });
    useActiveRideStream();
    mount();
    const es = FakeStream.instances[0];
    es.onmessage!({ data: JSON.stringify([{ id: 7, status: "active", paidUntilAt: 100 }]) });
    queryClient.setQueryData(["/api/rider/history"], ["cached"]);
    queryClient.setQueryData(["/api/rider/stats"], { rides: 1 });
    es.onmessage!({ data: JSON.stringify([{ id: 7, status: "active", paidUntilAt: 100, distanceM: 10 }]) });
    expect(queryClient.getQueryState(["/api/rider/history"])?.isInvalidated).toBe(false);
    es.onmessage!({ data: "[]" });
    expect(queryClient.getQueryState(["/api/rider/history"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["/api/rider/stats"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(["/api/rides/active"])).toEqual([]);
  });
  it("rejects late events and responses from a previous identity", async () => {
    queryClient.setQueryData(["/api/users/current"], { id: "a" });
    useActiveRideStream();
    mount();
    const es = FakeStream.instances[0];
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const pending = getQueryFn({ on401: "throw" })({
      queryKey: ["/api/bikes"], signal: new AbortController().signal, client: queryClient, meta: undefined,
    });
    acceptSessionUser({ id: "b" });
    queryClient.setQueryData(["/api/users/current"], { id: "b" });
    resolve(new Response(JSON.stringify(["old"])));
    await expect(pending).rejects.toThrow("Сессия изменилась");
    es.onmessage!({ data: JSON.stringify([{ id: 999 }]) });
    expect(queryClient.getQueryData(["/api/rides/active"])).toBeUndefined();
  });
  it("retains successful data on HTTP failure rather than inventing an empty list", async () => {
    const queryKey = ["/api/payment-methods"];
    queryClient.setQueryData(queryKey, [{ id: 1 }]);
    const observer = new QueryObserver(queryClient, { queryKey, queryFn: async () => { throw new Error("503"); } });
    cleanups.push(observer.subscribe(() => {}));
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    expect(observer.getCurrentResult().data).toEqual([{ id: 1 }]);
    expect(observer.getCurrentResult().dataUpdatedAt).toBeGreaterThan(0);
  });
  it("never sends an old account mutation after its CSRF wait crosses a session change", async () => {
    resetSessionData();
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = apiRequest("POST", "/api/support/chat", { body: "private draft" });
    resetSessionData();
    resolve(new Response(JSON.stringify({ csrfToken: "old-session" })));
    await expect(pending).rejects.toThrow("Сессия изменилась");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("fleet ticks refresh reservations; catalog changes refresh map zones", () => {
    for (const path of ["/api/bikes", "/api/map-objects", "/api/reservations/active"]) queryClient.setQueryData([path], []);
    useFleetStream();
    mount();
    const es = FakeStream.instances[0];
    es.listeners.get("message")!();
    expect(queryClient.getQueryState(["/api/reservations/active"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["/api/map-objects"])?.isInvalidated).toBe(false);
    es.listeners.get("catalog")!();
    expect(queryClient.getQueryState(["/api/map-objects"])?.isInvalidated).toBe(true);
  });
  it("reconciles on opening/reconnecting and recovers a silently dead stream", () => {
    vi.useFakeTimers();
    const sync = vi.fn();
    const close = openLiveStream("/test", { message: sync }, sync);
    cleanups.push(close);
    const old = FakeStream.instances[0];
    old.onopen!();
    expect(sync).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(50_000);
    expect(old.closed).toBe(true);
    expect(FakeStream.instances).toHaveLength(2);
    FakeStream.instances[1].onopen!();
    expect(sync).toHaveBeenCalledTimes(2);
    old.listeners.get("message")!();
    expect(sync).toHaveBeenCalledTimes(2);
    close();
    cleanups.pop();
    vi.advanceTimersByTime(60_000);
    expect(FakeStream.instances).toHaveLength(2);
  });
  it("keeps a live stream with observable heartbeats and has independent HTTP fallback", () => {
    vi.useFakeTimers();
    cleanups.push(openLiveStream("/test", {}, () => {}));
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(25_000);
      FakeStream.instances[0].listeners.get("heartbeat")!();
    }
    expect(FakeStream.instances).toHaveLength(1);
    expect(queryClient.getQueryDefaults(["/api/rides/active"]).refetchInterval).toBe(10_000);
    expect(queryClient.getQueryDefaults(["/api/reservations/active"]).refetchInterval).toBe(10_000);
  });
});

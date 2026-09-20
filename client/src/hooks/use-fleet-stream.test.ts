import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFleetStream } from "./use-fleet-stream";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  cleanup: undefined as (() => void) | undefined,
}));

vi.mock("react", () => ({
  useEffect: (effect: () => () => void) => { mocks.cleanup = effect(); },
}));

vi.mock("@/lib/queryClient", () => ({
  API_BASE: "",
  queryClient: { invalidateQueries: mocks.invalidateQueries },
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
}

describe("fleet stream updates admin rides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeEventSource.instances = [];
    mocks.cleanup = undefined;
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    mocks.cleanup?.();
    vi.unstubAllGlobals();
  });

  it("refreshes rides on the initial/reconnect tick and every start/end tick", () => {
    useFleetStream();
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe("/api/bikes/stream");

    for (let tick = 0; tick < 3; tick++) {
      mocks.invalidateQueries.mockClear();
      stream.onmessage?.();
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["/api/admin/rides"],
      });
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["/api/admin/bikes"],
      });
    }
  });

  it("closes the subscription on unmount", () => {
    useFleetStream();
    mocks.cleanup?.();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledOnce();
    mocks.cleanup = undefined;
  });

  it("shares one connection between mounted map and admin subscribers", () => {
    useFleetStream();
    const firstCleanup = mocks.cleanup!;
    useFleetStream();
    expect(FakeEventSource.instances).toHaveLength(1);
    firstCleanup();
    expect(FakeEventSource.instances[0].close).not.toHaveBeenCalled();
    mocks.cleanup?.();
    expect(FakeEventSource.instances[0].close).toHaveBeenCalledOnce();
    mocks.cleanup = undefined;
  });

  it("subscribes the rides page and refreshes when returning to the tab", () => {
    const page = readFileSync(
      new URL("../pages/RidesAdminPage.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain('import { useFleetStream } from "@/hooks/use-fleet-stream"');
    expect(page).toContain("useFleetStream();");
    expect(page).toContain("useAdminPage");
    const hook = readFileSync(new URL("./use-admin-page.ts", import.meta.url), "utf8");
    expect(hook).toContain('refetchOnWindowFocus: "always"');
    expect(hook).toContain('refetchOnReconnect: "always"');
  });
});

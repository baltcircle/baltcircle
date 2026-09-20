import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminDataSync } from "./AdminDataSync";
import { ADMIN_POLL_MS } from "@/lib/admin-freshness";

const effects = vi.hoisted(() => [] as (() => (() => void) | void)[]);
vi.mock("react", async (original) => ({
  ...(await original()),
  useEffect: (callback: () => (() => void) | void) => effects.push(callback),
}));
afterEach(() => {
  effects.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("headless administrative synchronization", () => {
  const render = (client: QueryClient) => {
    vi.stubGlobal("React", React);
    return renderToStaticMarkup(
      React.createElement(QueryClientProvider, { client }, React.createElement(AdminDataSync)),
    );
  };
  it("does not render a status row, timestamp or refresh button", () => {
    const client = new QueryClient();
    expect(render(client)).toBe("");
    client.clear();
  });
  it("retains SSE, fallback polling and cleanup without a visible row", () => {
    vi.useFakeTimers();
    const stream = {
      onopen: null as (() => void) | null,
      addEventListener: vi.fn(),
      close: vi.fn(),
    };
    vi.stubGlobal("EventSource", class { constructor() { return stream; } });
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    const client = new QueryClient();
    const refresh = vi.spyOn(client, "refetchQueries").mockResolvedValue();
    render(client);
    const cleanup = effects[0]();
    try {
      stream.onopen!();
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(ADMIN_POLL_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new Event("focus"));
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      cleanup?.();
      client.clear();
    }
    expect(stream.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(ADMIN_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

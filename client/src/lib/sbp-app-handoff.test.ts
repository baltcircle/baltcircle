import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markSbpAppHandoff, noteSbpAppHidden, consumeSbpAppHandoff, repairSbpViewport,
  createSbpViewportRecovery, continueSbpViewportRecovery,
} from "./sbp-app-handoff";

function environment() {
  const properties = new Map<string, string>([["display", "flex"]]);
  const scroller = { scrollTop: 120, scrollLeft: 2 };
  let reads = 0;
  const frame = {
    scrollTop: 0, scrollLeft: 0,
    style: {
      getPropertyValue: (key: string) => properties.get(key) ?? "",
      getPropertyPriority: () => "",
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    },
    querySelectorAll: () => [scroller],
    get offsetHeight() { reads++; scroller.scrollTop = 0; return 812; },
  };
  const active = { matches: vi.fn(() => false), blur: vi.fn(), focus: vi.fn() };
  const win = {
    innerWidth: 375, innerHeight: 812,
    visualViewport: { scale: 1 },
    document: {
      visibilityState: "visible",
      documentElement: { clientHeight: 812 },
      activeElement: active,
      querySelector: () => frame,
    },
  } as unknown as Window;
  return { win, frame, active, scroller, properties, reads: () => reads };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("SBP return viewport recovery", () => {
  it("does not mistake a focus event before leaving the app for a return", () => {
    const { win } = environment();
    markSbpAppHandoff(win);
    expect(consumeSbpAppHandoff()).toBeNull();
    noteSbpAppHidden();
    expect(consumeSbpAppHandoff()).toMatchObject({ height: 812, width: 375 });
    expect(consumeSbpAppHandoff()).toBeNull();
  });
  it("expires abandoned handoffs", () => {
    const { win } = environment();
    markSbpAppHandoff(win);
    noteSbpAppHidden();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    expect(consumeSbpAppHandoff()).toBeNull();
  });
  it("synchronously reflows only a shortened viewport and restores display and scrolling", () => {
    const e = environment();
    Object.defineProperty(e.win, "innerHeight", { get: () => e.reads() >= 2 ? 812 : 650 });
    expect(repairSbpViewport({ height: 812, width: 375 }, e.win)).toBe(true);
    expect(e.reads()).toBe(2);
    expect(e.properties.get("display")).toBe("flex");
    expect(e.scroller).toEqual({ scrollTop: 120, scrollLeft: 2 });
  });
  it("does not treat partial height recovery as success", () => {
    const e = environment();
    Object.defineProperty(e.win, "innerHeight", {
      get: () => e.reads() >= 4 ? 812 : e.reads() >= 2 ? 787 : 650,
    });
    expect(repairSbpViewport({ height: 812, width: 375 }, e.win)).toBe(false);
    expect(e.win.innerHeight).toBe(787);
    expect(repairSbpViewport({ height: 812, width: 375 }, e.win)).toBe(true);
    expect(e.win.innerHeight).toBe(812);
  });
  it("retries partial recovery on later samples, not recursively in one frame", () => {
    const e = environment();
    Object.defineProperty(e.win, "innerHeight", {
      get: () => e.reads() >= 4 ? 812 : e.reads() >= 2 ? 787 : 650,
    });
    const recovery = createSbpViewportRecovery({ height: 812, width: 375 }, 1000);
    expect(continueSbpViewportRecovery(recovery, e.win, 1000)).toBe(false);
    expect(continueSbpViewportRecovery(recovery, e.win, 1001)).toBe(false);
    expect(e.reads()).toBe(2);
    expect(continueSbpViewportRecovery(recovery, e.win, 1150)).toBe(true);
    expect(e.reads()).toBe(4);
  });
  it("stops after four unsuccessful attempts instead of repainting forever", () => {
    const e = environment();
    Object.defineProperty(e.win, "innerHeight", { value: 787 });
    const recovery = createSbpViewportRecovery({ height: 812, width: 375 }, 1000);
    for (const at of [1000, 1150, 1400]) {
      expect(continueSbpViewportRecovery(recovery, e.win, at)).toBe(false);
    }
    expect(continueSbpViewportRecovery(recovery, e.win, 1900)).toBe(true);
    expect(continueSbpViewportRecovery(recovery, e.win, 2000)).toBe(true);
    expect(e.reads()).toBe(8);
  });

  it.each(["hidden", "keyboard", "zoom"] as const)("does not spend attempts while %s", (mode) => {
    const e = environment();
    Object.defineProperty(e.win, "innerHeight", { value: 650 });
    if (mode === "hidden") Object.defineProperty(e.win.document, "visibilityState", { value: "hidden" });
    if (mode === "keyboard") e.active.matches.mockReturnValue(true);
    if (mode === "zoom") Object.defineProperty(e.win.visualViewport!, "scale", { value: 1.5 });
    const recovery = createSbpViewportRecovery({ height: 812, width: 375 }, 1000);
    expect(continueSbpViewportRecovery(recovery, e.win, 1000)).toBe(false);
    expect(recovery.attempts).toBe(0);
    expect(e.reads()).toBe(0);
  });

  it("guards synchronous events emitted by focus during reflow", () => {
    const e = environment();
    Object.defineProperty(e.win, "innerHeight", { value: 650 });
    const recovery = createSbpViewportRecovery({ height: 812, width: 375 }, 1000);
    e.active.focus.mockImplementation(() => {
      expect(continueSbpViewportRecovery(recovery, e.win, 1000)).toBe(false);
    });
    expect(continueSbpViewportRecovery(recovery, e.win, 1000)).toBe(false);
    expect(recovery.attempts).toBe(1);
    expect(e.reads()).toBe(2);
  });
  it.each(["expired", "rotated", "restored"] as const)("finishes an %s recovery without another repaint", (mode) => {
    const e = environment();
    if (mode !== "restored") Object.defineProperty(e.win, "innerHeight", { value: 787 });
    if (mode === "rotated") Object.defineProperty(e.win, "innerWidth", { value: 812 });
    const recovery = createSbpViewportRecovery({ height: 812, width: 375 }, 1000);
    expect(continueSbpViewportRecovery(recovery, e.win, mode === "expired" ? 3100 : 1000)).toBe(true);
    expect(e.reads()).toBe(0);
  });
  it.each(["normal", "rotation", "keyboard", "zoom", "hidden"] as const)("does not disturb %s", (mode) => {
    const e = environment();
    Object.defineProperty(e.win, "innerHeight", { value: mode === "normal" ? 812 : 650 });
    if (mode === "rotation") Object.defineProperty(e.win, "innerWidth", { value: 812 });
    if (mode === "keyboard") e.active.matches.mockReturnValue(true);
    if (mode === "zoom") Object.defineProperty(e.win.visualViewport, "scale", { value: 2 });
    if (mode === "hidden") Object.defineProperty(e.win.document, "visibilityState", { value: "hidden" });
    expect(repairSbpViewport({ height: 812, width: 375 }, e.win)).toBe(false);
    expect(e.reads()).toBe(0);
  });
});

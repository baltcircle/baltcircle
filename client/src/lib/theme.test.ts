// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type ThemeMode } from "./theme";

describe("immediate application theme", () => {
  let root: Root;
  let container: HTMLDivElement;
  let controls: ReturnType<typeof useTheme>;
  let prefersDark: boolean;
  let listeners: Set<() => void>;
  let commits: Array<{ mode: ThemeMode; theme: string }>;
  let classAfterSelection: boolean;

  function Consumer() {
    controls = useTheme();
    useLayoutEffect(() => {
      commits.push({ mode: controls.mode, theme: controls.theme });
    });
    return createElement("button", {
      onClick: () => {
        controls.setMode("dark");
        classAfterSelection = document.documentElement.classList.contains("dark");
      },
    }, controls.theme);
  }

  function mount(mode: ThemeMode = "light") {
    localStorage.setItem("baltcircle-theme", mode);
    act(() => root.render(createElement(ThemeProvider, null, createElement(Consumer))));
    commits.length = 0;
  }

  function systemChange(dark: boolean) {
    prefersDark = dark;
    act(() => listeners.forEach((listener) => listener()));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    prefersDark = false;
    listeners = new Set();
    commits = [];
    classAfterSelection = false;
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return prefersDark; },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    })));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("updates the root within the selection handler, before leaving settings", () => {
    mount();
    act(() => container.querySelector("button")!.click());
    expect(classAfterSelection).toBe(true);
    expect(localStorage.getItem("baltcircle-theme")).toBe("dark");
  });

  it("never commits a new mode with an old resolved theme", () => {
    mount();
    act(() => controls.setMode("dark"));
    expect(commits).toEqual([{ mode: "dark", theme: "dark" }]);
    commits.length = 0;
    act(() => controls.setMode("light"));
    expect(commits).toEqual([{ mode: "light", theme: "light" }]);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("applies the saved theme and native control colour scheme on mount", () => {
    mount("dark");
    expect(controls.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("resolves Auto immediately and follows subsequent system changes", () => {
    mount();
    prefersDark = true;
    act(() => controls.setMode("system"));
    expect(commits).toEqual([{ mode: "system", theme: "dark" }]);
    systemChange(false);
    expect(controls.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("does not let system changes override an explicit theme", () => {
    mount("system");
    act(() => controls.setMode("dark"));
    systemChange(false);
    expect(controls.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it("still switches when saving the preference is blocked", () => {
    mount();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    expect(() => act(() => controls.setMode("dark"))).not.toThrow();
    expect(controls.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("toggles both ways without intermediate stale commits", () => {
    mount();
    act(() => controls.toggle());
    act(() => controls.toggle());
    expect(commits).toEqual([
      { mode: "dark", theme: "dark" },
      { mode: "light", theme: "light" },
    ]);
  });
});

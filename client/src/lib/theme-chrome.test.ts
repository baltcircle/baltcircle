import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStyle } from "@/components/map/mapStyle";
import { applyThemeChrome, MAP_WATER_COLORS } from "./theme-chrome";

describe.each(["light", "dark"] as const)("browser chrome in %s theme", (theme) => {
  it("matches the map water and CSS fallback exactly", () => {
    const style = buildStyle({ type: "pmtiles", url: "/test.pmtiles" }, 0, 15, theme) as {
      layers: { id: string; paint?: Record<string, unknown> }[];
    };
    expect(style.layers.find((layer) => layer.id === "background")?.paint?.["background-color"]).toBe(MAP_WATER_COLORS[theme]);
    const css = readFileSync(resolve("client/src/index.css"), "utf8");
    expect(css).toContain(`--map-water: ${MAP_WATER_COLORS[theme]};`);
  });
  it("updates the html theme, backdrop and existing browser meta synchronously", () => {
    const classes = new Set<string>();
    const properties = new Map<string, string>();
    const meta = { content: "" };
    const doc = {
      documentElement: {
        classList: { toggle: (name: string, active: boolean) => active ? classes.add(name) : classes.delete(name) },
        style: { setProperty: (name: string, value: string) => properties.set(name, value) },
      },
      querySelector: () => meta,
    } as unknown as Document;
    applyThemeChrome(theme === "dark" ? "light" : "dark", doc);
    applyThemeChrome(theme, doc);
    expect(classes.has("dark")).toBe(theme === "dark");
    expect(properties.get("--map-water")).toBe(MAP_WATER_COLORS[theme]);
    expect(meta.content).toBe(MAP_WATER_COLORS[theme]);
  });
});

it("uses the theme water variable for the top guard and locked viewport", () => {
  const shell = readFileSync(resolve("client/src/components/AppShell.tsx"), "utf8");
  const css = readFileSync(resolve("client/src/index.css"), "utf8");
  expect(shell).toContain('backgroundColor: "var(--map-water)"');
  expect(css).toContain("background-color: var(--map-water) !important");
});

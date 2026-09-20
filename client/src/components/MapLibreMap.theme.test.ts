import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/MapLibreMap.tsx"), "utf8");
const themeEffect = source.slice(source.indexOf("// ── THEME:"), source.indexOf("// ── GEOLOCATION:"));

describe("map theme timing regressions", () => {
  it("updates the map style before paint, even underneath a settings overlay", () => {
    expect(themeEffect).toContain("useLayoutEffect(() =>");
    expect(themeEffect).not.toMatch(/isOverlay|visibilityState/);
  });

  it("compares the actual map theme instead of skipping the first ready update", () => {
    expect(source).not.toContain("appliedInitialThemeRef");
    expect(source).toContain("appliedThemeRef.current = themeRef.current");
    expect(themeEffect).toContain("appliedThemeRef.current === theme");
    expect(themeEffect).toContain("appliedThemeRef.current = theme");
  });

  it("registers the data-restore handler before changing the style", () => {
    expect(themeEffect.indexOf('map.once("style.load", onStyleLoad)'))
      .toBeLessThan(themeEffect.indexOf("map.setStyle("));
  });
});

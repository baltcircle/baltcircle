import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const map = readFileSync(resolve(process.cwd(), "client/src/pages/MapPage.tsx"), "utf8");
const scan = readFileSync(resolve(process.cwd(), "client/src/pages/map/ScanAndPaymentBanner.tsx"), "utf8");
const operations = readFileSync(resolve(process.cwd(), "client/src/pages/OperationsMapPage.tsx"), "utf8");
const editor = readFileSync(resolve(process.cwd(), "client/src/pages/MapEditorPage.tsx"), "utf8");
const button = (source: string, id: string) =>
  source.match(new RegExp(`data-testid="${id}"\\s+className="([^"]+)"`))?.[1] ?? "";

describe("map action button appearance", () => {
  it.each([
    ["home-menu-button", map],
    ["home-geolocate-button", map],
    ["home-primary-scan", scan],
  ])("uses rounded rectangles for %s", (id, source) => {
    const classes = button(source, id);
    expect(classes).toContain("rounded-2xl");
    expect(classes).not.toContain("rounded-full");
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("text-black");
  });
  it("retains the touch target sizes and labels", () => {
    expect(button(map, "home-menu-button")).toContain("w-12 h-12");
    expect(button(map, "home-geolocate-button")).toContain("w-12 h-12");
    expect(button(scan, "home-primary-scan")).toContain("w-full h-14");
    expect(map).toContain('aria-label="Открыть меню"');
    expect(map).toContain('aria-label="Моё местоположение"');
  });
  it("uses a filled navigation arrow rather than a map pin", () => {
    const geolocate = map.match(/data-testid="home-geolocate-button"[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(geolocate).toContain("<Navigation");
    expect(geolocate).toContain('fill="currentColor"');
    expect(geolocate).not.toContain("<MapPin");
  });
  it.each([
    ["button-operations-geolocate", operations],
    ["button-editor-geolocate", editor],
  ])("matches the main map geolocation control for %s", (id, source) => {
    const control = source.match(new RegExp(`<button\\b(?:(?!<\\/button>)[\\s\\S])*?data-testid="${id}"[\\s\\S]*?<\\/button>`))?.[0] ?? "";
    expect(control).toContain("<Navigation");
    expect(control).toContain('fill="currentColor"');
    expect(control).not.toContain("<MapPin");
    expect(control).toContain("rounded-2xl");
    expect(control).not.toContain("rounded-full");
    expect(control).toContain("w-12 h-12");
    expect(control).toContain("bg-primary text-black");
    expect(control).toContain('aria-label="Моя геопозиция"');
    expect(control).toContain("onClick={handleGeolocate}");
  });
});

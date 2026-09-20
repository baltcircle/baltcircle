import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecification, SymbolLayerSpecification } from "maplibre-gl";
import { buildStyle, type MapTheme } from "./mapStyle";

function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

describe.each<MapTheme>(["light", "dark"])("street labels in %s theme", (theme) => {
  const style = buildStyle({ type: "pmtiles", url: "/kaliningrad.pmtiles" }, 0, 15, theme) as StyleSpecification;
  const label = style.layers.find((layer) => layer.id === "road-labels") as SymbolLayerSpecification;

  it("uses a crisp opaque halo and contrasting text instead of the road colour", () => {
    const paint = label.paint!;
    const text = paint["text-color"] as string;
    const halo = paint["text-halo-color"] as string;
    expect(halo).toMatch(/^#[a-f0-9]{6}$/i);
    expect(paint["text-halo-width"]).toBeGreaterThanOrEqual(1.5);
    expect(paint["text-halo-blur"]).toBe(0);
    const values = [luminance(text), luminance(halo)].sort((a, b) => b - a);
    expect((values[0] + 0.05) / (values[1] + 0.05)).toBeGreaterThanOrEqual(4.5);
    const road = style.layers.find((layer) => layer.id === "road-inner");
    expect(text).not.toBe(road?.type === "line" ? road.paint?.["line-color"] : undefined);
  });

  it("draws street names above roads, zones and tracks but below the user marker", () => {
    const index = (id: string) => style.layers.findIndex((layer) => layer.id === id);
    for (const id of ["road-outline", "road-inner", "cycleway", "road-rail", "building",
      "saved-zone-fill", "saved-zone-line", "saved-route-line", "ride-track-line",
      "editor-draft-fill", "editor-draft-line"]) {
      expect(index(id), id).toBeGreaterThanOrEqual(0);
      expect(index(id), id).toBeLessThan(index("road-labels"));
    }
    expect(index("road-labels")).toBeLessThan(index("user-location-shadow"));
    expect(label.layout?.["symbol-placement"]).toBe("line");
    expect(label.layout?.["text-allow-overlap"]).not.toBe(true);
  });

  it("produces a valid MapLibre style with a single street-label layer", () => {
    expect(style.layers.filter((layer) => layer.id === "road-labels")).toHaveLength(1);
    expect(validateStyleMin(style)).toEqual([]);
  });
});

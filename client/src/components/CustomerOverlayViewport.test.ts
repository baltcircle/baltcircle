import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("customer overlay viewport after bank return", () => {
  it("keeps the opaque page surface at the guarded app height, separate from visible content", () => {
    const app = readFileSync(resolve("client/src/App.tsx"), "utf8");
    expect(app).toContain("<CustomerOverlayViewport");
    const frame = readFileSync(resolve("client/src/components/CustomerOverlayViewport.tsx"), "utf8");
    expect(frame).toContain('height: "max(100dvh, var(--app-height, 100dvh))"');
    expect(frame).toContain('height: "var(--visible-height, 100dvh)"');
    expect(frame).toContain('marginTop: "var(--visible-top, 0px)"');
    expect(frame).toContain("bg-background");
    expect(frame).toContain("min-h-0");
  });
});

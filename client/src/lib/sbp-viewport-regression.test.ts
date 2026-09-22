import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("iOS viewport after an SBP app handoff", () => {
  const css = readFileSync(resolve("client/src/index.css"), "utf8");
  const hook = readFileSync(resolve("client/src/hooks/use-app-viewport.tsx"), "utf8");
  const page = readFileSync(resolve("client/src/pages/PaymentMethodsPage.tsx"), "utf8");

  it("does not size the locked root from percentage containing blocks", () => {
    const lock = css.slice(css.indexOf("html.route-locked,")).split("}")[0];
    expect(lock).not.toContain("height: 100%");
    expect(lock).toContain("height: 100vh");
    expect(lock).toContain("min-height: 100vh");
  });

  it("marks the SBP handoff and consumes it on restore for an explicit root repaint", () => {
    expect(page).toContain("markSbpAppHandoff()");
    expect(hook).toContain("consumeSbpAppHandoff()");
    expect(hook).toContain("createSbpViewportRecovery(handoff)");
    expect(hook).toContain("continueSbpViewportRecovery(sbpRestore)");
  });
});

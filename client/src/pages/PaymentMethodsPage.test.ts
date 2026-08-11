import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This project currently uses Node-only Vitest tests and does not include a DOM
// component-test environment. Keep the binding-state contract covered directly
// against the page source.
const source = readFileSync(resolve(process.cwd(), "client/src/pages/PaymentMethodsPage.tsx"), "utf8");

describe("PaymentMethodsPage binding controls", () => {
  it("does not render the relocated consent or cancellation disclosures", () => {
    expect(source).not.toContain("autoChargeConsent");
    expect(source).not.toContain('data-testid="checkbox-autocharge-consent"');
    expect(source).not.toContain('data-testid="text-autocharge-consent"');
    expect(source).not.toContain('data-testid="text-autocharge-cancel-info"');
  });

  it("gates both binding buttons only while the page is busy", () => {
    const cardButton = source.slice(
      source.indexOf('data-testid="button-bind-card"') - 300,
      source.indexOf('data-testid="button-bind-card"') + 100,
    );
    const sbpButton = source.slice(
      source.indexOf('data-testid="button-add-sbp"') - 300,
      source.indexOf('data-testid="button-add-sbp"') + 100,
    );

    expect(cardButton).toContain("disabled={busy}");
    expect(sbpButton).toContain("disabled={busy}");
  });
});

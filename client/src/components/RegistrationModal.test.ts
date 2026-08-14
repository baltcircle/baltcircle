import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/RegistrationModal.tsx"), "utf8");

describe("RegistrationModal agreement acceptance", () => {
  it("requires the checkbox and links each consent document to its information section", () => {
    expect(source).toContain('data-testid="checkbox-personal-data-consent"');
    expect(source).toContain('href="/safety#legal-terms"');
    expect(source).toContain('data-testid="link-terms"');
    expect(source).toContain('href="/safety#legal-privacy"');
    expect(source).toContain('data-testid="link-privacy"');
    expect(source).toContain('href="/safety#legal-consent"');
    expect(source).toContain('data-testid="link-consent"');
    expect(source).toContain("disabled={startMut.isPending || !consent || resendIn > 0}");
  });

  it("does not claim that card data is not requested", () => {
    expect(source).not.toContain("Данные карты не запрашиваются.");
  });
});

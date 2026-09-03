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

  it("opens the legal links via in-app navigation instead of a new tab/window", () => {
    // Opening the link with a blank-target attribute launched /safety in a fresh
    // browsing context with a single history entry — the back arrow and window
    // close were both dead ends there.
    expect(source).not.toMatch(/<Link[^>]*target=/);
    expect(source).not.toMatch(/<a\s/);
    expect(source).toContain('import { Link } from "wouter"');
  });

  it("closes the dialog before navigating and reopens it with preserved data on return", () => {
    expect(source).toContain("returningFromLegalRef");
    expect(source).toContain('window.addEventListener("popstate", handlePopState)');
    // The reset-on-open effect must skip clearing name/phone/consent when we're
    // reopening after a legal-document read, not a brand-new registration.
    expect(source).toMatch(/if \(returningFromLegalRef\.current\) \{\s*returningFromLegalRef\.current = false;\s*return;\s*\}/);
  });
});

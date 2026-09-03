import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/RegistrationModal.tsx"), "utf8");

describe("RegistrationModal agreement acceptance", () => {
  it("requires the checkbox and links each consent document to the /legal page", () => {
    expect(source).toContain('data-testid="checkbox-personal-data-consent"');
    expect(source).toContain('data-testid="link-terms"');
    expect(source).toContain('href="/legal#terms"');
    expect(source).toContain('data-testid="link-privacy"');
    expect(source).toContain('href="/legal#privacy"');
    expect(source).toContain('data-testid="link-consent"');
    expect(source).toContain('href="/legal#consent"');
    expect(source).toContain("disabled={startMut.isPending || !consent || resendIn > 0}");
  });

  it("does not claim that card data is not requested", () => {
    expect(source).not.toContain("Данные карты не запрашиваются.");
  });

  it("navigates to the existing /legal page instead of a nested dialog", () => {
    // /legal is rendered by LegalIndexPage via OverlayShell — the same header,
    // back-arrow and swipe-back chrome as every other overlay page (e.g.
    // /safety), so legal documents look and behave consistently everywhere.
    expect(source).toContain('import { Link } from "wouter"');
    expect(source).not.toContain("getLegalDoc");
    expect(source).not.toContain('data-testid="dialog-legal-doc"');
    expect(source).not.toContain("legalDocSlug");
  });

  it("persists entered name/phone across the /legal round trip and reopens the form", () => {
    // RegistrationModal is rendered inside overlay pages (e.g. RentPage on
    // /rent) that unmount when another overlay route (/legal) becomes
    // active, discarding the form's local state. sessionStorage survives
    // that unmount/remount, so the form reopens with what the rider typed.
    expect(source).toContain('sessionStorage.setItem(REG_REOPEN_KEY, "1")');
    expect(source).toContain("sessionStorage.setItem(REG_NAME_KEY, name)");
    expect(source).toContain("sessionStorage.setItem(REG_PHONE_KEY, phoneDigits)");
    expect(source).toContain('sessionStorage.getItem(REG_REOPEN_KEY) === "1"');
    expect(source).toContain("addEventListener(\"popstate\", tryRestore)");
    expect(source).toContain("onOpenChange(true)");
  });
});

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

  it("closes the modal before navigating so /legal is not hidden behind it", () => {
    // Hosts that stay mounted across overlay-route changes (e.g. MapPage,
    // which is never unmounted to keep the map alive) would otherwise leave
    // the Dialog open while /legal renders, so the legal page would appear
    // stuck behind/under the still-open registration dialog.
    expect(source).toMatch(/function saveFormBeforeLegalNav\(\)[\s\S]*?onOpenChange\(false\);\n {2}\}/);
  });

  it("rounds the dialog corners on every viewport", () => {
    // The shared DialogContent only rounds corners at the sm: breakpoint
    // and above, so on mobile (the common case for riders) the registration
    // window had square corners. Override to a consistent radius everywhere.
    expect(source).toContain('data-testid="dialog-registration" className="rounded-2xl sm:rounded-2xl"');
  });

  it("strips an autofilled leading country-code digit from the phone field", () => {
    // Password managers/autofill often insert the full number including the
    // country code (7 or 8), but the code is already fixed as a separate
    // "+7" prefix in the UI. Naively slicing to 10 digits would drop the
    // trailing digit instead of the leading country-code digit, producing a
    // wrong number. normalizePhoneDigits() must strip a leading 7/8 when
    // exactly 11 digits were pasted/autofilled.
    expect(source).toContain("function normalizePhoneDigits(raw: string): string {");
    expect(source).toMatch(/digits\.length === 11 && \(digits\[0\] === "7" \|\| digits\[0\] === "8"\)/);
    expect(source).toContain("onChange={(e) => setPhoneDigits(normalizePhoneDigits(e.target.value))}");

    function normalizePhoneDigits(raw: string): string {
      const digits = raw.replace(/\D/g, "");
      if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) {
        return digits.slice(1);
      }
      return digits.slice(0, 10);
    }
    expect(normalizePhoneDigits("89114765700")).toBe("9114765700");
    expect(normalizePhoneDigits("+79114765700")).toBe("9114765700");
    expect(normalizePhoneDigits("9114765700")).toBe("9114765700");
    expect(normalizePhoneDigits("891147657001234")).toBe("8911476570");
  });
});

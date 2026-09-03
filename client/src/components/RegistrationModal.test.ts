import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/RegistrationModal.tsx"), "utf8");

describe("RegistrationModal agreement acceptance", () => {
  it("requires the checkbox and gives each consent document a legal-doc trigger", () => {
    expect(source).toContain('data-testid="checkbox-personal-data-consent"');
    expect(source).toContain('data-testid="link-terms"');
    expect(source).toContain('setLegalDocSlug("terms")');
    expect(source).toContain('data-testid="link-privacy"');
    expect(source).toContain('setLegalDocSlug("privacy")');
    expect(source).toContain('data-testid="link-consent"');
    expect(source).toContain('setLegalDocSlug("consent")');
    expect(source).toContain("disabled={startMut.isPending || !consent || resendIn > 0}");
  });

  it("does not claim that card data is not requested", () => {
    expect(source).not.toContain("Данные карты не запрашиваются.");
  });

  it("opens legal documents in a nested dialog instead of navigating away", () => {
    // Navigating to /safety (whether via target="_blank" or an in-app SPA
    // route change) unmounted the registration form: RegistrationModal is
    // rendered inside overlay pages (e.g. RentPage on /rent) that themselves
    // unmount when another overlay route becomes active, so the back arrow
    // returned to the map/home screen instead of back to the registration
    // form. A nested Dialog avoids navigation and history entirely.
    expect(source).not.toMatch(/<a\s/);
    expect(source).not.toContain('import { Link } from "wouter"');
    expect(source).not.toContain('href="/safety#legal-');
    expect(source).toContain('data-testid="dialog-legal-doc"');
    expect(source).toContain("getLegalDoc(legalDocSlug)");
  });

  it("keeps the registration form and its entered data intact while reading a legal document", () => {
    // The legal-doc dialog is a separate piece of state (legalDocSlug) layered
    // on top of the same mounted form — closing it just clears that state,
    // it never touches name/phone/consent or re-triggers the open-reset effect.
    expect(source).toContain("const [legalDocSlug, setLegalDocSlug] = useState");
    expect(source).toMatch(/<Dialog open=\{legalDocSlug !== null\}/);
    expect(source).toContain('data-testid="button-legal-doc-close"');
  });
});

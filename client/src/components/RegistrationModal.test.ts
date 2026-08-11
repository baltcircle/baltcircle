import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/RegistrationModal.tsx"), "utf8");

describe("RegistrationModal agreement acceptance", () => {
  it("requires the checkbox that links to the user agreement before registration", () => {
    expect(source).toContain('data-testid="checkbox-personal-data-consent"');
    expect(source).toContain('href="/legal#terms"');
    expect(source).toContain('data-testid="link-terms"');
    expect(source).toContain("disabled={startMut.isPending || !consent || resendIn > 0}");
  });
});

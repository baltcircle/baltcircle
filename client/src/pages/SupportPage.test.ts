import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/SupportPage.tsx"), "utf8");

describe("SupportPage guest state", () => {
  it("uses the rides-style icon, heading, and explanatory text without a login button", () => {
    expect(source).toContain("LifeBuoy");
    expect(source).toContain('data-testid="empty-support-guest"');
    expect(source).toContain('<LifeBuoy className="w-10 h-10 mx-auto opacity-40 mb-3" />');
    expect(source).toContain('className="font-display text-lg font-light mb-1"');
    expect(source).toContain("Поддержка доступна после входа");
    expect(source).toContain("Войдите в аккаунт, чтобы написать в поддержку.");
    expect(source).not.toContain("button-login-from-support");
  });
});

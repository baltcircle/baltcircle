import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/SettingsPage.tsx"), "utf8");

describe("SettingsPage account controls", () => {
  it("renders logout and account-deletion controls with stable test ids", () => {
    expect(source).toContain('data-testid="button-logout"');
    expect(source).toContain('data-testid="button-delete-account"');
    expect(source).toContain('data-testid="button-confirm-delete-account"');
  });

  it("requires an AlertDialog confirmation and clears cached auth data after either action", () => {
    expect(source).toContain("<AlertDialog");
    expect(source).toContain("Это действие нельзя отменить.");
    expect(source).toContain('apiRequest("POST", "/api/auth/logout")');
    expect(source).toContain('apiRequest("DELETE", "/api/account")');
    expect(source.match(/queryClient\.clear\(\)/g)).toHaveLength(2);
  });
});

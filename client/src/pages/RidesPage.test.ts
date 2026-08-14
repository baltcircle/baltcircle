import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/RidesPage.tsx"), "utf8");

describe("RidesPage guest state", () => {
  it("keeps the explanatory message but no longer renders a login CTA", () => {
    expect(source).toContain("История доступна после входа");
    expect(source).toContain("Войдите в аккаунт, чтобы видеть свои завершённые поездки, дистанцию и стоимость.");
    expect(source).not.toContain('button-login-from-rides');
    expect(source).not.toContain('<Link href="/settings">');
    expect(source).not.toContain("LogIn");
  });
});

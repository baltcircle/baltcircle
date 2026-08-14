import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/DrawerMenu.tsx"), "utf8");

describe("DrawerMenu guest login entry point", () => {
  it("shows the guest card as a login action that opens the existing registration modal", () => {
    expect(source).toContain('import { RegistrationModal } from "@/components/RegistrationModal";');
    expect(source).toContain("const [registrationOpen, setRegistrationOpen] = useState(false);");
    expect(source).toContain('data-testid="button-drawer-guest-login"');
    expect(source).toContain('onClick={() => setRegistrationOpen(true)}');
    expect(source).toContain('<RegistrationModal open={registrationOpen} onOpenChange={setRegistrationOpen} />');
    expect(source).toContain('{isRegistered ? user?.name ?? "Гость" : "Войти"}');
  });

  it("keeps the signed-in profile card linked to settings", () => {
    expect(source).toMatch(/isRegistered\s*\?\s*\(\s*<Link\s+href="\/settings"/);
  });
});

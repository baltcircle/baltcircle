import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const profile = readFileSync(resolve(process.cwd(), "client/src/pages/settings/ProfileSection.tsx"), "utf8");
const settings = readFileSync(resolve(process.cwd(), "client/src/pages/SettingsPage.tsx"), "utf8");
const modal = readFileSync(resolve(process.cwd(), "client/src/components/EmailChangeModal.tsx"), "utf8");

describe("Профиль: подтверждение почты", () => {
  it("подпись показывается только при указанной, но неподтверждённой почте", () => {
    // Почту вводят на шаге регистрации без подтверждения, поэтому email может
    // быть заполнен, а emailVerifiedAt — пустым. Пустая почта подписи не даёт:
    // подтверждать нечего.
    expect(profile).toContain("const needsEmailVerification = !!user?.email && !user?.emailVerifiedAt;");
    expect(profile).toContain("{needsEmailVerification ? (");
    expect(profile).toContain("Подтвердите почту");
    expect(profile).toContain('data-testid="button-verify-email"');
    expect(profile).toContain("text-red-500");
  });

  it("подпись — отдельная кнопка, а не элемент внутри строки почты", () => {
    // <button> внутри <button> — невалидная разметка, и клик по подписи
    // открывал бы смену почты вместо подтверждения.
    const emailBlock = profile.slice(profile.indexOf("{/* Email */}"));
    expect(emailBlock.indexOf("onClick={onOpenEmailModal}")).toBeLessThan(
      emailBlock.indexOf("onClick={onOpenEmailVerifyModal}"),
    );
    expect(emailBlock).toMatch(/<\/button>[\s\S]*?onClick=\{onOpenEmailVerifyModal\}/);
  });

  it("подпись открывает подтверждение, а строка почты — смену", () => {
    expect(settings).toContain('setEmailModalMode("change"); setEmailModalOpen(true);');
    expect(settings).toContain('setEmailModalMode("verify"); setEmailModalOpen(true);');
    expect(settings).toContain("mode={emailModalMode}");
    expect(settings).toContain("currentEmail={user?.email ?? null}");
  });

  it("в режиме подтверждения адрес подставлен и не редактируется", () => {
    // Иначе подтверждение превратилось бы в скрытую смену почты.
    expect(modal).toContain('const verifyOnly = mode === "verify" && !!currentEmail;');
    expect(modal).toContain("setEmail(verifyOnly ? currentEmail! : \"\");");
    expect(modal).toContain("readOnly={verifyOnly}");
    expect(modal).toContain("Подтверждение почты");
  });

  it("после подтверждения список пользователей перечитывается — подпись исчезает", () => {
    expect(modal).toContain("queryClient.setQueryData(CURRENT_USER_KEY, user);");
    expect(modal).toContain("queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });");
  });
});

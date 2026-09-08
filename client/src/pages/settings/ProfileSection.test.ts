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
    expect(profile).toContain("{needsEmailVerification && (");
    expect(profile).toContain("Подтвердите почту");
    expect(profile).toContain('data-testid="text-verify-email"');
    expect(profile).toContain("text-red-500");
  });

  it("подпись — текст внутри строки, а не отдельная кнопка", () => {
    // Нажимают на саму почту; <button> внутри <button> к тому же невалиден.
    const emailBlock = profile.slice(profile.indexOf("{/* Email */}"));
    expect(emailBlock).not.toContain("onOpenEmailVerifyModal");
    expect(emailBlock.match(/<button/g) ?? []).toHaveLength(1);
    expect(emailBlock).toMatch(/data-testid="text-verify-email"[\s\S]*?<\/button>/);
  });

  it("строка почты сама выбирает окно: подтверждение или смена", () => {
    expect(settings).toContain('setEmailModalMode(user?.email && !user?.emailVerifiedAt ? "verify" : "change");');
    expect(settings).toContain("mode={emailModalMode}");
    expect(settings).toContain("currentEmail={user?.email ?? null}");
  });

  it("в режиме подтверждения адрес подставлен, но остаётся редактируемым", () => {
    // При регистрации могли ошибиться в почте: код должен уйти на исправленный
    // адрес, а подтверждение — заодно поменять почту в профиле.
    expect(modal).toContain('const verifyOnly = mode === "verify" && !!currentEmail;');
    expect(modal).toContain("setEmail(verifyOnly ? currentEmail! : \"\");");
    expect(modal).not.toContain("readOnly");
    expect(modal).toContain('{verifyOnly ? "Подтвердить почту" : "Сменить почту"}');
  });

  it("статус подтверждения не выводится отдельной подписью", () => {
    // Единственный индикатор — красная подпись у неподтверждённой почты;
    // зелёная отметка у подтверждённой только шумела.
    expect(profile).not.toContain("Подтверждён");
    expect(profile).not.toContain("text-green-500");
  });

  it("после подтверждения список пользователей перечитывается — подпись исчезает", () => {
    expect(modal).toContain("queryClient.setQueryData(CURRENT_USER_KEY, user);");
    expect(modal).toContain("queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });");
  });
});

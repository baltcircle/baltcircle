import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/OtpCodeField.tsx"), "utf8");
const email = readFileSync(resolve(process.cwd(), "client/src/components/EmailChangeModal.tsx"), "utf8");

describe("OtpCodeField", () => {
  it("рисует кружки по числу цифр кода: полые до ввода, залитые по мере набора", () => {
    // Раньше слой показывал точки только по факту ввода, и пустое поле
    // выглядело сломанным — непонятно, куда вводить и сколько цифр ждут.
    expect(source).toContain("Array.from({ length: OTP_CODE_LENGTH }, (_, i) => (");
    expect(source).toContain("i < value.length");
    expect(source).toContain('"border-foreground bg-foreground"');
    expect(source).toContain('"border-muted-foreground/50 bg-transparent"');
  });

  it("оставляет один настоящий input прозрачным слоем поверх кружков", () => {
    // Один input — потому что autoComplete="one-time-code" работает только на
    // текстовом поле, а тап по любому кружку должен его фокусировать.
    expect(source).toContain("otp-masked absolute inset-0 h-full w-full");
    expect(source).toContain('autoComplete="one-time-code"');
    // Именно текстовое поле: с type="password" iOS перестаёт подставлять код
    // из SMS. Ищем в атрибутах, а не по всему файлу — в комментарии рядом
    // password упомянут намеренно.
    expect(source).toMatch(/<Input[\s\S]*?type="text"/);
    expect(source).not.toMatch(/<Input[\s\S]*?type="password"/);
    expect(source).toContain("maxLength={OTP_CODE_LENGTH}");
    expect(source).toContain("onChange(sanitizeOtpInput(e.target.value))");
  });
});

describe("EmailChangeModal: шаг кода", () => {
  it("использует общее поле кода", () => {
    expect(email).toContain('import { OtpCodeField } from "@/components/OtpCodeField";');
    expect(email).toContain('id="email-change-code"');
    expect(email).toContain('label="Код из письма"');
    expect(email).not.toContain('<Label htmlFor="email-change-code">');
  });

  it("оформлен как окно входа: заголовок по центру, пояснение скрыто", () => {
    expect(email).toContain('<DialogTitle className="font-display font-light text-center">Введите код</DialogTitle>');
    expect(email).toContain('<DialogDescription className="sr-only">');
    expect(email).not.toContain("<ShieldCheck");
  });

  it("шаг адреса тоже минималистичен: заголовок по центру, поле без рамки", () => {
    expect(email).toContain('{verifyOnly ? "Подтвердить почту" : "Сменить почту"}');
    expect(email).toContain("w-full border-0 bg-transparent p-0 text-xl text-center");
    expect(email).not.toContain('<Label htmlFor="email-change-input">');
    expect(email).not.toContain("<Mail");
    // Обе кнопки столбцом, действие сверху.
    expect(email.match(/<DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2 sm:space-x-0">/g) ?? [])
      .toHaveLength(2);
    expect(email.indexOf('data-testid="button-email-change-send"'))
      .toBeLessThan(email.indexOf('data-testid="button-email-change-close"'));
  });

  it("кнопки идут столбцом во всю ширину, подтверждение первым", () => {
    const footer = email.slice(email.indexOf('data-testid="button-email-change-verify"'));
    expect(email).toContain('<DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2 sm:space-x-0">');
    expect(footer).toContain('data-testid="button-email-change-back"');
    expect(email).toContain('variant="ghost"');
  });
});

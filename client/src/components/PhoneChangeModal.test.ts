import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const phone = read("client/src/components/PhoneChangeModal.tsx");
const push = read("client/src/pages/settings/PushNotificationsSection.tsx");
const theme = read("client/src/pages/settings/ThemeSection.tsx");
const profile = read("client/src/pages/settings/ProfileSection.tsx");

describe("PhoneChangeModal: оформление как в окне входа", () => {
  it("заголовок по центру и без иконки, пояснение скрыто", () => {
    expect(phone).toContain('<DialogTitle className="font-display font-light text-center">');
    expect(phone).toContain('{step === "phone" ? "Сменить номер телефона" : "Введите код"}');
    expect(phone).toContain('<DialogDescription className="sr-only">');
    expect(phone).not.toContain("<Smartphone");
    expect(phone).not.toContain("<ShieldCheck");
  });

  it("номер вводится маской с отдельным +7, как при входе", () => {
    // Общий модуль форматирования, а не своя обработка: иначе смена номера и
    // вход разошлись бы по виду и по тому, что уходит на сервер.
    expect(phone).toContain('import { formatPhoneDigits, applyPhoneInput, normalizePhoneDigits } from "@/lib/phone";');
    expect(phone).toContain("value={formatPhoneDigits(phoneDigits)}");
    expect(phone).toContain("setPhoneDigits(applyPhoneInput(e.target.value, phoneDigits))");
    expect(phone).toContain('placeholder="900 000-00-00"');
    expect(phone).toContain('autoComplete="tel-national"');
    expect(phone).toContain("phone: `+7${phoneDigits}`");
    expect(phone).toContain('normalizePhoneDigits(phoneDigits).length < 10');
  });

  it("код вводится общим полем с кружками", () => {
    expect(phone).toContain('import { OtpCodeField } from "@/components/OtpCodeField";');
    expect(phone).toContain('id="phone-change-code"');
    expect(phone).not.toContain('<Label htmlFor="phone-change-code">');
  });

  it("кнопки идут столбцом, действие сверху", () => {
    expect(phone.match(/<DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2 sm:space-x-0">/g) ?? [])
      .toHaveLength(2);
    expect(phone.indexOf('data-testid="button-phone-change-send"'))
      .toBeLessThan(phone.indexOf('data-testid="button-phone-change-close"'));
    expect(phone.indexOf('data-testid="button-phone-change-verify"'))
      .toBeLessThan(phone.indexOf('data-testid="button-phone-change-back"'));
  });

  it("клик мимо карточки окно не закрывает", () => {
    // Случайный тап по карте посреди ввода обнулял бы номер или код.
    expect(phone).toContain("onInteractOutside={(event) => event.preventDefault()}");
  });
});

describe("Настройки: лишние подписи убраны", () => {
  it("секции уведомлений и темы идут без заголовков", () => {
    // Внутри каждой карточки один пункт, и заголовок дублировал его название.
    expect(push).not.toContain("Уведомления</p>");
    expect(theme).not.toContain("Настройки приложения</p>");
    expect(push).toContain("Push уведомления");
    expect(theme).toContain("Тема приложения");
  });

  it("подпись о неподтверждённой почте стоит рядом с «Email»", () => {
    const label = profile.slice(profile.indexOf(">\n              Email"), profile.indexOf("</span>\n          </span>"));
    expect(label).toContain("Подтвердите почту");
    expect(label).toContain('className="ml-2 font-medium text-red-500"');
    expect(profile).not.toContain('className="block text-xs mt-1 font-medium text-red-500"');
  });
});

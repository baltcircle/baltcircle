import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/AuthModal.tsx"), "utf8");

describe("AuthModal agreement acceptance", () => {
  it("requires the checkbox and links each consent document to the /legal page", () => {
    expect(source).toContain('data-testid="checkbox-personal-data-consent"');
    expect(source).toContain('data-testid="link-terms"');
    expect(source).toContain('href="/legal#terms"');
    expect(source).toContain('data-testid="link-privacy"');
    expect(source).toContain('href="/legal#privacy"');
    expect(source).toContain('data-testid="link-consent"');
    expect(source).toContain('href="/legal#consent"');
    expect(source).toContain("disabled={registerCompleteMut.isPending || !consent}");
  });

  it("does not claim that card data is not requested", () => {
    expect(source).not.toContain("Данные карты не запрашиваются.");
  });

  it("navigates to the existing /legal page instead of a nested dialog", () => {
    // /legal is rendered by LegalIndexPage via OverlayShell — the same header,
    // back-arrow and swipe-back chrome as every other overlay page (e.g.
    // /safety), so legal documents look and behave consistently everywhere.
    expect(source).toContain('import { Link } from "wouter"');
    expect(source).not.toContain("getLegalDoc");
    expect(source).not.toContain('data-testid="dialog-legal-doc"');
    expect(source).not.toContain("legalDocSlug");
  });

  it("persists entered name/email/phone and the current step across the /legal round trip and reopens the form", () => {
    // AuthModal is rendered inside overlay pages (e.g. RentPage on /rent)
    // that unmount when another overlay route (/legal) becomes active,
    // discarding the form's local state. sessionStorage survives that
    // unmount/remount, so the form reopens with what the rider typed and on
    // the same step (the profile-completion step, the only one with /legal
    // links).
    expect(source).toContain('sessionStorage.setItem(AUTH_REOPEN_KEY, "1")');
    expect(source).toContain('sessionStorage.setItem(AUTH_STEP_KEY, "profile")');
    expect(source).toContain("sessionStorage.setItem(AUTH_NAME_KEY, name)");
    expect(source).toContain("sessionStorage.setItem(AUTH_EMAIL_KEY, email)");
    expect(source).toContain("sessionStorage.setItem(AUTH_PHONE_KEY, phoneDigits)");
    expect(source).toContain('sessionStorage.getItem(AUTH_REOPEN_KEY) === "1"');
    expect(source).toContain("addEventListener(\"popstate\", tryRestore)");
    expect(source).toContain("onOpenChange(true)");
  });

  it("closes the modal before navigating so /legal is not hidden behind it", () => {
    // Hosts that stay mounted across overlay-route changes (e.g. MapPage,
    // which is never unmounted to keep the map alive) would otherwise leave
    // the Dialog open while /legal renders, so the legal page would appear
    // stuck behind/under the still-open auth dialog.
    expect(source).toMatch(/function saveFormBeforeLegalNav\(\)[\s\S]*?onOpenChange\(false\);\n {2}\}/);
  });

  it("rounds the dialog corners on every viewport", () => {
    // The shared DialogContent only rounds corners at the sm: breakpoint
    // and above, so on mobile (the common case for riders) the auth window
    // had square corners. Override to a consistent radius everywhere.
    expect(source).toContain('data-testid="dialog-auth"');
    expect(source).toContain('className="rounded-2xl sm:rounded-2xl"');
  });

  it("не закрывается по клику мимо карточки", () => {
    // Диалог висит поверх карты, вокруг него много пустого места: случайный
    // тап посреди ввода номера или кода обнулял бы форму. Закрытие оставлено
    // только на явные действия — крестик, кнопка «Закрыть», Escape.
    expect(source).toContain("onInteractOutside={(event) => event.preventDefault()}");
  });

  it("телефон вводится и хранится цифрами, а показывается с разделителями", () => {
    // Автозаполнение подставляет номер вместе с кодом страны, а "+7" в UI —
    // отдельный фиксированный префикс. Нормализация и форматирование вынесены
    // в @/lib/phone (там же юнит-тесты), компонент обязан их использовать, а не
    // складывать разделители в состояние.
    expect(source).toContain('from "@/lib/phone"');
    expect(source).toContain("value={formatPhoneDigits(phoneDigits)}");
    expect(source).toContain("onChange={(e) => setPhoneDigits(applyPhoneInput(e.target.value, phoneDigits))}");
    expect(source).toContain('const phone = phoneDigits ? "+7" + phoneDigits : "";');
    expect(source).not.toMatch(/function normalizePhoneDigits/);
  });

  it("shows a single phone-entry step first, without a manual login/register toggle", () => {
    // The server decides login vs. registration from the OTP verify result
    // (see POST /api/auth/otp/verify) — the rider never picks a mode
    // up front, so there is no separate "signup"/"login" tab or toggle link.
    expect(source).toContain('useState<"phone" | "code" | "profile">("phone")');
    expect(source).toContain('data-testid="input-auth-phone"');
    expect(source).not.toContain("Don't have an account");
    expect(source).not.toContain("Signup");
  });

  it("branches to a profile-completion step only for brand-new phones", () => {
    expect(source).toContain('data.status === "register"');
    expect(source).toContain('setStep("profile")');
    expect(source).toContain('data-testid="input-auth-name"');
    expect(source).toContain('data-testid="input-auth-email"');
    expect(source).toContain("/api/auth/register-complete");
  });
});

describe("AuthModal: экраны телефона и кода", () => {
  it("описания обоих шагов скрыты визуально, но остаются для скринридера", () => {
    // Radix связывает диалог с описанием через aria-describedby: выкинуть узел
    // из DOM — значит потерять подпись и получить предупреждение в консоли.
    expect(source).toContain('<DialogDescription className="sr-only">{description}</DialogDescription>');
  });

  it("поле телефона без рамки, по центру и с доступным именем вместо лейбла", () => {
    expect(source).toContain('aria-label="Номер телефона"');
    expect(source).not.toContain('<Label htmlFor="auth-phone">');
    expect(source).toContain("border-0 bg-transparent");
    expect(source).toContain("text-center");
  });

  it("на шагах телефона и кода заголовок по центру и без иконки", () => {
    expect(source).toContain('<DialogTitle className="font-display font-light text-center">');
    expect(source).not.toContain("<Phone ");
    expect(source).not.toContain("<ShieldCheck");
    expect(source).not.toContain("<UserPlus");
  });

  it("заголовки шагов сформулированы как действие", () => {
    expect(source).toContain('step === "phone" ? "Введите номер телефона" : step === "code" ? "Введите код"');
  });

  it("поле кода без рамки, крупное и с маскировкой символов", () => {
    expect(source).not.toContain('<Label htmlFor="auth-code">');
    expect(source).toContain('aria-label="Код из SMS"');
    expect(source).toContain("otp-masked");
    // Точки рисует отдельный слой: маскировка средствами браузера
    // (-webkit-text-security) на устройстве пользователя не сработала.
    expect(source).toContain('data-testid="text-auth-code-mask"');
    expect(source).toContain('{"•".repeat(code.length)}');
    // type остаётся текстовым: с password iOS не подставляет код из SMS.
    expect(source).toContain('autoComplete="one-time-code"');
    expect(source).toMatch(/id="auth-code"[\s\S]*?type="text"/);
    // Ширина только w-full: фиксированная в ch обрезала шестизначный код,
    // потому что трекинг добавляет к каждому символу лишние 0.4em.
    expect(source).toContain("h-auto w-full border-0 bg-transparent p-0 pl-[0.4em] text-center font-mono text-2xl");
    expect(source).not.toContain("w-[7ch]");
  });

  it("статус SMS-провайдера не показывается пользователю", () => {
    expect(source).not.toContain("SMS отправлено, статус");
    expect(source).not.toContain('data-testid="text-sms-status"');
  });

  it("кнопки шага кода идут столбцом во всю ширину", () => {
    const codeStep = source.slice(source.indexOf('{step === "code" && ('), source.indexOf('{step === "profile" && ('));
    expect(codeStep).toContain('<DialogFooter className="flex-col gap-2 sm:flex-col">');
    expect(codeStep.indexOf('data-testid="button-verify-otp"')).toBeLessThan(
      codeStep.indexOf('data-testid="button-auth-back"'),
    );
    expect(codeStep.match(/className="w-full"/g)?.length).toBe(2);
  });
});

describe("AuthModal: экран регистрации", () => {
  it("поля имени и почты без рамок, по центру и с доступными именами", () => {
    expect(source).not.toContain('<Label htmlFor="auth-name">');
    expect(source).not.toContain('<Label htmlFor="auth-email">');
    expect(source).toContain('aria-label="Имя"');
    expect(source).toContain('aria-label="Почта"');
    const profileStep = source.slice(source.indexOf('{step === "profile" && ('));
    const bare = profileStep.match(
      /className="h-auto border-0 bg-transparent px-0 py-2 text-center text-lg shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"/g,
    );
    expect(bare?.length).toBe(2);
  });

  it("лейбл согласия остаётся — там кликабельный текст, а не подпись поля", () => {
    expect(source).toContain('<Label htmlFor="consent"');
  });
});

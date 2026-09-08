import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { OTP_CODE_LENGTH, OTP_CODE_REGEX, sanitizeOtpInput, isCompleteOtp } from "./otp";
import { otpVerifySchema, phoneChangeVerifySchema, emailChangeVerifySchema } from "@shared/schema";

// Регрессия на кнопку «Подтвердить», которая оставалась заблокированной при
// верном коде: гейт кнопки был захардкожен под одну длину, а сервер выдавал
// другую. Теперь длина одна на всех (shared/otp.ts), и тесты проверяют именно
// согласованность генератора, схем и UI, а не конкретное число.

const fullCode = "1".repeat(OTP_CODE_LENGTH);
const paddedCode = "0".repeat(OTP_CODE_LENGTH - 1) + "7";

// Единственная точка входа значения в поле — onChange: набор с клавиатуры,
// вставка и автоподстановка из SMS приходят одинаково.
function typeIntoField(chars: string[]): string {
  let value = "";
  for (const ch of chars) value = sanitizeOtpInput(value + ch);
  return value;
}

function pasteIntoField(pasted: string): string {
  return sanitizeOtpInput(pasted);
}

describe("OTP_CODE_LENGTH", () => {
  it("совпадает с генератором на сервере", () => {
    const server = readFileSync(resolve(process.cwd(), "server/storage/otp.ts"), "utf8");
    // Генератор обязан считать длину из общей константы, а не из числа в коде.
    expect(server).toContain('import { OTP_CODE_LENGTH } from "@shared/otp";');
    expect(server).toContain('String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, "0")');
  });

  it("совпадает с zod-схемами всех трёх OTP-потоков", () => {
    for (const schema of [otpVerifySchema, phoneChangeVerifySchema, emailChangeVerifySchema]) {
      expect(schema.safeParse({ phone: "+79001234567", code: fullCode }).success).toBe(true);
      expect(schema.safeParse({ phone: "+79001234567", code: fullCode + "1" }).success).toBe(false);
      expect(schema.safeParse({ phone: "+79001234567", code: fullCode.slice(1) }).success).toBe(false);
    }
  });

  it("регулярное выражение принимает ровно OTP_CODE_LENGTH цифр", () => {
    expect(OTP_CODE_REGEX.test(fullCode)).toBe(true);
    expect(OTP_CODE_REGEX.test(paddedCode)).toBe(true);
    expect(OTP_CODE_REGEX.test(fullCode.slice(1))).toBe(false);
    expect(OTP_CODE_REGEX.test(fullCode + "1")).toBe(false);
  });
});

describe("sanitizeOtpInput", () => {
  it("оставляет только цифры и обрезает по длине кода", () => {
    expect(sanitizeOtpInput(fullCode)).toBe(fullCode);
    expect(sanitizeOtpInput("1-2 3 4 5 6")).toBe("123456".slice(0, OTP_CODE_LENGTH));
    expect(sanitizeOtpInput("1234567890")).toBe("1234567890".slice(0, OTP_CODE_LENGTH));
  });

  it("не съедает ведущие нули", () => {
    expect(sanitizeOtpInput(paddedCode)).toBe(paddedCode);
  });
});

describe("isCompleteOtp", () => {
  it("включает кнопку для кода, набранного по одной цифре", () => {
    const typed = typeIntoField(fullCode.split(""));
    expect(typed).toBe(fullCode);
    expect(isCompleteOtp(typed)).toBe(true);
  });

  it("включает кнопку для кода из вставки или автоподстановки SMS", () => {
    expect(isCompleteOtp(pasteIntoField(fullCode))).toBe(true);
  });

  it("включает кнопку для кода с ведущими нулями", () => {
    expect(isCompleteOtp(typeIntoField(paddedCode.split("")))).toBe(true);
    expect(isCompleteOtp(pasteIntoField(paddedCode))).toBe(true);
  });

  it("держит кнопку заблокированной, пока код неполон", () => {
    expect(isCompleteOtp("")).toBe(false);
    expect(isCompleteOtp(fullCode.slice(1))).toBe(false);
  });

  it("принимает более длинный ввод, обрезая его", () => {
    expect(isCompleteOtp(fullCode + "9")).toBe(true);
  });

  it("игнорирует разделители при проверке полноты", () => {
    expect(isCompleteOtp(fullCode.split("").join(" "))).toBe(true);
    expect(isCompleteOtp(fullCode.slice(1).split("").join("-"))).toBe(false);
  });
});

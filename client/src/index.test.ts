import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "client/src/index.css"), "utf8");

describe("index.css: автозаполнение и маскировка OTP", () => {
  it("гасит жёлтую заливку автозаполнения переходом, а не background-color", () => {
    // Браузерный стиль -webkit-autofill сильнее обычного background-color;
    // единственный работающий приём — бесконечный transition.
    expect(css).toContain("input:-webkit-autofill");
    expect(css).toContain("transition: background-color 100000s ease-in-out 0s;");
    expect(css).toContain("-webkit-text-fill-color: hsl(var(--foreground));");
    expect(css).toContain("caret-color: hsl(var(--foreground));");
  });

  it("прячет символы OTP, в том числе у автозаполненного поля", () => {
    // -webkit-text-security на устройстве не сработал, поэтому текст просто
    // делается прозрачным, а точки рисует отдельный слой в разметке.
    expect(css).toContain(".otp-masked,");
    expect(css).toContain(".otp-masked:-webkit-autofill");
    expect(css).toContain("-webkit-text-fill-color: transparent;");
    expect(css).toContain("color: transparent;");
  });
});

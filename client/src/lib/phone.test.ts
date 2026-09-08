import { describe, it, expect } from "vitest";
import { normalizePhoneDigits, formatPhoneDigits, applyPhoneInput } from "./phone";

describe("normalizePhoneDigits", () => {
  it("отбрасывает код страны у полного номера", () => {
    expect(normalizePhoneDigits("89114765700")).toBe("9114765700");
    expect(normalizePhoneDigits("+79114765700")).toBe("9114765700");
  });

  it("оставляет десять цифр как есть и обрезает лишнее", () => {
    expect(normalizePhoneDigits("9114765700")).toBe("9114765700");
    expect(normalizePhoneDigits("891147657001234")).toBe("8911476570");
  });

  it("выбрасывает разделители", () => {
    expect(normalizePhoneDigits("900 123-45-67")).toBe("9001234567");
  });
});

describe("formatPhoneDigits", () => {
  it("расставляет разделители 3 / 3 / 2 / 2", () => {
    expect(formatPhoneDigits("9001234567")).toBe("900 123-45-67");
  });

  it("не оставляет висящих разделителей на неполном номере", () => {
    expect(formatPhoneDigits("")).toBe("");
    expect(formatPhoneDigits("9")).toBe("9");
    expect(formatPhoneDigits("900")).toBe("900");
    expect(formatPhoneDigits("9001")).toBe("900 1");
    expect(formatPhoneDigits("900123")).toBe("900 123");
    expect(formatPhoneDigits("9001234")).toBe("900 123-4");
    expect(formatPhoneDigits("90012345")).toBe("900 123-45");
    expect(formatPhoneDigits("900123456")).toBe("900 123-45-6");
  });

  it("игнорирует лишние символы и длину", () => {
    expect(formatPhoneDigits("900 123-45-67")).toBe("900 123-45-67");
    expect(formatPhoneDigits("90012345678888")).toBe("900 123-45-67");
  });
});

describe("applyPhoneInput", () => {
  it("добавляет набранную цифру", () => {
    expect(applyPhoneInput("900 123-45-6", "90012345")).toBe("900123456");
  });

  it("стирает цифру, когда Backspace попал на разделитель", () => {
    // "900 123-45" → Backspace убирает "-", набор цифр не изменился бы и поле
    // залипло бы на разделителе.
    expect(applyPhoneInput("900 12345", "90012345")).toBe("9001234");
    expect(applyPhoneInput("900123", "900123")).toBe("90012");
  });

  it("обычное стирание цифры работает как всегда", () => {
    expect(applyPhoneInput("900 123-4", "90012345")).toBe("9001234");
  });

  it("принимает вставку полного номера с кодом страны", () => {
    expect(applyPhoneInput("+7 911 476-57-00", "")).toBe("9114765700");
  });
});

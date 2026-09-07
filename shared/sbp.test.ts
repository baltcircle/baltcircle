import { describe, expect, it } from "vitest";
import { filterSbpBanks, isSafeBankLogoUrl, isValidSbpBankId, sortSbpBanks } from "./sbp";

describe("isValidSbpBankId", () => {
  it("принимает опаковые идентификаторы эквайрера", () => {
    expect(isValidSbpBankId("100000000004")).toBe(true);
    expect(isValidSbpBankId("bank_100000000004-v2.1")).toBe(true);
  });

  it("отвергает всё, что нельзя вложить в подписанный запрос", () => {
    // Значение уходит в тело запроса к T-Bank и участвует в подписи, поэтому
    // пробелы, кавычки, переводы строк и пустая строка отсекаются до вызова.
    for (const bad of ["", " ", "плохой id", "a b", "id\n", '"id"', "a".repeat(65), 42, null, undefined]) {
      expect(isValidSbpBankId(bad)).toBe(false);
    }
  });
});

describe("isSafeBankLogoUrl", () => {
  it("пропускает только https", () => {
    expect(isSafeBankLogoUrl("https://cdn.test/logo.svg")).toBe(true);
    expect(isSafeBankLogoUrl("http://cdn.test/logo.svg")).toBe(false);
    expect(isSafeBankLogoUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeBankLogoUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isSafeBankLogoUrl("//cdn.test/logo.svg")).toBe(false);
    expect(isSafeBankLogoUrl("не ссылка")).toBe(false);
  });
});

describe("sortSbpBanks", () => {
  const names = (list: { id: string; name: string }[]) => sortSbpBanks(list).map((b) => b.name);

  it("узнаёт банк с приставкой организационной формы и в кавычках", () => {
    expect(names([
      { id: "1", name: "Банк Зета" },
      { id: "2", name: "ПАО «Сбербанк»" },
      { id: "3", name: "АО «Т-Банк»" },
    ])).toEqual(["АО «Т-Банк»", "ПАО «Сбербанк»", "Банк Зета"]);
  });

  it("не поднимает банк, у которого популярное слово внутри названия", () => {
    // Совпадение по подстроке вытащило бы «Банк Альфа-Омега» наверх заодно с
    // Альфа-Банком, хотя это разные организации.
    expect(names([
      { id: "1", name: "Альфа-Банк" },
      { id: "2", name: "Банк Альфа-Омега" },
    ])).toEqual(["Альфа-Банк", "Банк Альфа-Омега"]);
  });

  it("сохраняет порядок эквайрера внутри одной группы", () => {
    expect(names([
      { id: "1", name: "Банк А" },
      { id: "2", name: "Банк Б" },
      { id: "3", name: "Банк В" },
    ])).toEqual(["Банк А", "Банк Б", "Банк В"]);
  });
});

describe("filterSbpBanks", () => {
  const banks = [
    { id: "1", name: "Т-Банк" },
    { id: "2", name: "Сбербанк" },
    { id: "3", name: "Газпромбанк" },
  ];

  it("ищет без учёта регистра и по подстроке", () => {
    expect(filterSbpBanks(banks, "сбер").map((b) => b.id)).toEqual(["2"]);
    expect(filterSbpBanks(banks, "БАНК").map((b) => b.id)).toEqual(["1", "2", "3"]);
  });

  it("пустой запрос не фильтрует", () => {
    expect(filterSbpBanks(banks, "   ")).toHaveLength(3);
  });
});

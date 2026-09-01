import { describe, expect, it } from "vitest";
import { cleanErr, cleanErrWithDetails } from "./api-error";

describe("cleanErr", () => {
  it("strips the '<status>: ' prefix and surfaces a JSON body's error field", () => {
    expect(cleanErr(new Error('400: {"error":"Неверный номер телефона"}'))).toBe(
      "Неверный номер телефона",
    );
  });

  it("falls back to the raw body when it isn't JSON", () => {
    expect(cleanErr(new Error("500: Internal Server Error"))).toBe("Internal Server Error");
  });

  it("falls back to the full message when there is no '<status>: ' prefix", () => {
    expect(cleanErr(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("falls back to the raw body when the JSON has no error field", () => {
    expect(cleanErr(new Error('409: {"code":"CONFLICT"}'))).toBe('{"code":"CONFLICT"}');
  });
});

describe("cleanErrWithDetails", () => {
  it("appends a parenthetical code when present", () => {
    expect(
      cleanErrWithDetails(new Error('400: {"error":"Банк отклонил операцию","code":"51"}')),
    ).toBe("Банк отклонил операцию (код 51)");
  });

  it("appends details distinct from the message, joined with the code", () => {
    expect(
      cleanErrWithDetails(
        new Error(
          '400: {"error":"Отклонено","code":"51","details":"Insufficient funds"}',
        ),
      ),
    ).toBe("Отклонено (код 51, Insufficient funds)");
  });

  it("omits the parenthetical when details equal the message", () => {
    expect(
      cleanErrWithDetails(new Error('400: {"error":"Отклонено","details":"Отклонено"}')),
    ).toBe("Отклонено");
  });

  it("falls back to the raw body when there is no JSON error field", () => {
    expect(cleanErrWithDetails(new Error("500: boom"))).toBe("boom");
  });
});

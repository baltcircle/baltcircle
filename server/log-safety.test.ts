import { describe, expect, it } from "vitest";
import { sanitizeLogMessage } from "./log-safety";

describe("sanitizeLogMessage", () => {
  it("preserves ordinary Unicode, quotes, dollar signs and JSON text", () => {
    const text = 'Ответ банка: "ошибка" $abc {"ok":false}';
    expect(sanitizeLogMessage(text)).toBe(text);
    expect(sanitizeLogMessage("")).toBe("");
  });
  it("removes forged line boundaries", () => {
    expect(sanitizeLogMessage("rejected\r\nINFO forged\nnext\r"))
      .toBe("rejectedINFO forgednext");
  });
  it("removes terminal controls and Unicode line separators", () => {
    const controls = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i))
      .concat(Array.from({ length: 33 }, (_, i) => String.fromCharCode(127 + i)))
      .join("") + "\u2028\u2029";
    expect(sanitizeLogMessage(`before${controls}after`)).toBe("beforeafter");
  });
});

import { describe, expect, it } from "vitest";
import { errMessage } from "./error-utils";

describe("errMessage", () => {
  it("returns the message of an Error instance", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a thrown string as-is", () => {
    expect(errMessage("plain string throw")).toBe("plain string throw");
  });

  it("returns undefined for an empty string", () => {
    expect(errMessage("")).toBeUndefined();
  });

  it("returns undefined for non-Error, non-string values", () => {
    expect(errMessage({ code: 42 })).toBeUndefined();
    expect(errMessage(null)).toBeUndefined();
    expect(errMessage(undefined)).toBeUndefined();
  });
});

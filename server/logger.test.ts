import { afterEach, describe, expect, it, vi } from "vitest";
import { log, logger } from "./logger";

afterEach(() => { vi.restoreAllMocks(); });

describe("log message boundary", () => {
  it("preserves the existing default source", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    log("ordinary message");
    expect(spy).toHaveBeenCalledWith({ source: "express" }, "ordinary message");
  });
  it("cleans both the message and source before calling Pino", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    log("denied\r\nFORGED", "tbank\r\nFORGED");
    expect(spy).toHaveBeenCalledWith({ source: "tbankFORGED" }, "deniedFORGED");
  });
});

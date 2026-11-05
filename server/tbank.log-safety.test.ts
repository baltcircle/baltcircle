import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";
import { tbankGetState, type TbankConfig } from "./tbank";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("T-Bank log injection regression", () => {
  it("sanitizes a rejected response without changing the returned data", async () => {
    const cfg: TbankConfig = {
      terminalKey: "sample-terminal", password: "non-secret-test-value",
      apiBase: "https://bank.invalid/v2", publicAppUrl: "https://app.invalid",
      addCardCheckType: "3DS", cardBindAmountKopecks: 100, cardBindMethod: "payment",
    };
    const response = { Success: false, ErrorCode: "1", Message: "denied\r\nFORGED" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);
    const spy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const result = await tbankGetState(cfg, "sample-payment");
    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      { source: "tbank" }, "[tbank] /GetState rejected: 1 deniedFORGED",
    );
  });
});

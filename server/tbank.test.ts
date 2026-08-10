import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReceipt,
  computeToken,
  tbankInitRidePayment,
  tbankInitSavedCardCharge,
  tbankRefundVerificationCharge,
} from "./tbank";
import type { TbankConfig } from "./tbank";

const cfg: TbankConfig = {
  terminalKey: "test-terminal",
  password: "test-password",
  apiBase: "https://tbank.test/v2",
  publicAppUrl: "https://app.test",
  addCardCheckType: "3DS",
  cardBindAmountKopecks: 100,
  cardBindMethod: "payment",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildReceipt", () => {
  it("uses email in preference to phone and applies the confirmed fiscal values", () => {
    expect(buildReceipt({
      customerEmail: " rider@example.test ",
      customerPhone: "+79991234567",
      description: "Аренда велосипеда",
      amountKopecks: 35000,
    })).toEqual({
      Email: "rider@example.test",
      Taxation: "usn_income_outcome",
      Items: [{
        Name: "Аренда велосипеда",
        Price: 35000,
        Quantity: 1,
        Amount: 35000,
        Tax: "none",
        PaymentMethod: "full_payment",
        PaymentObject: "service",
      }],
    });
  });

  it("falls back to phone, removes control characters, and limits the item name", () => {
    const receipt = buildReceipt({
      customerPhone: "+79991234567",
      description: `${"а".repeat(127)}\n${"б".repeat(10)}`,
      amountKopecks: 100,
    });

    expect(receipt.Phone).toBe("+79991234567");
    expect(receipt.Email).toBeUndefined();
    expect(receipt.Items[0].Name).toHaveLength(128);
    expect(receipt.Items[0].Name).not.toContain("\n");
  });

  it("rejects a receipt without a customer contact", () => {
    expect(() => buildReceipt({
      description: "Аренда велосипеда",
      amountKopecks: 100,
    })).toThrow("email или телефон");
  });
});

describe("fiscalized T-Bank requests", () => {
  it("sends a nested receipt on one-off Init without including it in Token", async () => {
    let captured: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body));
      return { json: async () => ({ Success: true, PaymentURL: "https://pay.test" }) };
    }));

    await tbankInitRidePayment(cfg, {
      orderId: "TRRP-test",
      amountKopecks: 35000,
      description: "Аренда велосипеда BC-1",
      customerKey: "rider-1",
      customerPhone: "+79991234567",
      successUrl: "https://app.test/success",
      failUrl: "https://app.test/fail",
      notificationUrl: "https://app.test/notify",
    });

    expect(captured).toMatchObject({
      Receipt: {
        Phone: "+79991234567",
        Taxation: "usn_income_outcome",
        Items: [expect.objectContaining({
          Name: "Аренда велосипеда BC-1",
          Amount: 35000,
          Tax: "none",
          PaymentMethod: "full_payment",
          PaymentObject: "service",
        })],
      },
    });
    const { Token, Receipt, ...rootScalars } = captured as Record<string, unknown>;
    expect(computeToken(rootScalars, cfg.password)).toBe(Token);
    expect(Receipt).toBeDefined();
  });

  it("sends a receipt on saved-card Init and the matching receipt on Cancel", async () => {
    const captures: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      captures.push({ url, body: JSON.parse(String(init?.body)) });
      return { json: async () => ({ Success: true, PaymentId: "payment-1", Status: "REFUNDED" }) };
    }));

    await tbankInitSavedCardCharge(cfg, {
      orderId: "TRSC-test",
      amountKopecks: 50000,
      description: "Аренда велосипеда BC-2",
      customerKey: "rider-2",
      customerEmail: "rider@example.test",
      notificationUrl: "https://app.test/notify",
    });
    await tbankRefundVerificationCharge(cfg, {
      paymentId: "bind-payment-1",
      knownStatus: "CONFIRMED",
      amountKopecks: 100,
      customerEmail: "rider@example.test",
    });

    expect(captures[0]).toMatchObject({
      url: "https://tbank.test/v2/Init",
      body: {
        OperationInitiatorType: "R",
        Receipt: expect.objectContaining({
          Email: "rider@example.test",
          Items: [expect.objectContaining({ Amount: 50000 })],
        }),
      },
    });
    expect(captures[1]).toMatchObject({
      url: "https://tbank.test/v2/Cancel",
      body: {
        PaymentId: "bind-payment-1",
        Receipt: {
          Email: "rider@example.test",
          Taxation: "usn_income_outcome",
          Items: [expect.objectContaining({
            Name: "Проверка карты",
            Amount: 100,
            Tax: "none",
            PaymentMethod: "full_payment",
            PaymentObject: "service",
          })],
        },
      },
    });
  });
});

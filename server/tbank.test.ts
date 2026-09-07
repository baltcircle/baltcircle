import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReceipt,
  classifyInitBinding,
  classifyRidePayment,
  computeToken,
  tbankAddAccountQr,
  tbankChargeQr,
  tbankGetQrBankList,
  tbankInitRidePayment,
  tbankInitSavedCardCharge,
  tbankInitSbpCharge,
  tbankRefundVerificationCharge,
  normalizeSbpBanks,
  verifyNotificationToken,
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

// Audit LOW: timing-safe webhook signature comparison.
describe("verifyNotificationToken", () => {
  const password = "webhook-secret";
  const body = { OrderId: "order-1", Status: "CONFIRMED", Amount: 19900 };

  it("accepts a correctly computed token (case-insensitively)", () => {
    const token = computeToken(body as any, password);
    expect(verifyNotificationToken({ ...body, Token: token }, password)).toBe(true);
    expect(verifyNotificationToken({ ...body, Token: token.toUpperCase() }, password)).toBe(true);
  });

  it("rejects a wrong-but-same-length token without throwing", () => {
    const token = computeToken(body as any, password);
    const tampered = (token[0] === "0" ? "1" : "0") + token.slice(1);
    expect(verifyNotificationToken({ ...body, Token: tampered }, password)).toBe(false);
  });

  it("rejects a token of the wrong length without throwing (timingSafeEqual length guard)", () => {
    expect(verifyNotificationToken({ ...body, Token: "deadbeef" }, password)).toBe(false);
    expect(verifyNotificationToken({ ...body, Token: "" }, password)).toBe(false);
  });

  it("rejects a missing Token field", () => {
    expect(verifyNotificationToken({ ...body }, password)).toBe(false);
  });

  it("rejects a token computed with the wrong password", () => {
    const token = computeToken(body as any, "other-password");
    expect(verifyNotificationToken({ ...body, Token: token }, password)).toBe(false);
  });
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

describe("classifyInitBinding", () => {
  it("activates an authorized verification payment once T-Bank returns its recurring token", () => {
    expect(classifyInitBinding({
      status: "AUTHORIZED",
      rebillId: "rebill-authorized",
    })).toBe("active");
  });
});

describe("classifyRidePayment (audit HIGH #1)", () => {
  it("treats AUTHORIZED as still pending, NOT paid — it is only a held auth, not a capture", () => {
    expect(classifyRidePayment({ status: "AUTHORIZED" })).toBe("pending");
  });

  it("treats CONFIRMED as paid — the charge has actually been captured", () => {
    expect(classifyRidePayment({ status: "CONFIRMED" })).toBe("paid");
  });

  it("treats COMPLETED as paid", () => {
    expect(classifyRidePayment({ status: "COMPLETED" })).toBe("paid");
  });

  it("treats an explicit rejection as failed", () => {
    expect(classifyRidePayment({ status: "REJECTED" })).toBe("failed");
    expect(classifyRidePayment({ status: "AUTHORIZED", success: false })).toBe("failed");
  });

  it("treats an intermediate status as pending", () => {
    expect(classifyRidePayment({ status: "FORM_SHOWED" })).toBe("pending");
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

// ChargeQr требует BankMemberId, когда счёт привязан в стороннем банке. Пустое
// или отсутствующее значение нельзя слать как пустую строку: она попала бы в
// подпись и вернула бы код 204 вместо списания.
describe("СБП: ChargeQr и BankMemberId", () => {
  async function capture(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return { json: async () => ({ Success: true, Status: "CONFIRMED" }) };
    }));
    await fn();
    return body;
  }

  it("передаёт BankMemberId и подписывает его вместе с остальными полями", async () => {
    const body = await capture(() => tbankChargeQr(cfg, {
      paymentId: "payment-1",
      accountToken: "account-token-1",
      bankMemberId: "100000000004",
    }));

    expect(body).toMatchObject({
      PaymentId: "payment-1",
      AccountToken: "account-token-1",
      BankMemberId: "100000000004",
    });
    const { Token, ...scalars } = body;
    expect(computeToken(scalars, cfg.password)).toBe(Token);
  });

  it("опускает поле целиком, когда банк неизвестен", async () => {
    const body = await capture(() => tbankChargeQr(cfg, {
      paymentId: "payment-1",
      accountToken: "account-token-1",
    }));

    expect(body).not.toHaveProperty("BankMemberId");
    const { Token, ...scalars } = body;
    expect(computeToken(scalars, cfg.password)).toBe(Token);
  });

  it("не шлёт пустую строку вместо отсутствующего банка", async () => {
    const body = await capture(() => tbankChargeQr(cfg, {
      paymentId: "payment-1",
      accountToken: "account-token-1",
      bankMemberId: "   ",
    }));

    expect(body).not.toHaveProperty("BankMemberId");
  });

  it("Init рекуррентного СБП-платежа держит DATA вне подписи", async () => {
    // DATA — вложенный объект: он уходит в теле, но в токен не попадает, иначе
    // терминал ответит 204 на каждое списание.
    const body = await capture(() => tbankInitSbpCharge(cfg, {
      orderId: "TRSQ-test",
      amountKopecks: 35000,
      description: "Аренда велосипеда BC-3",
      customerKey: "rider-3",
      notificationUrl: "https://app.test/notify",
    }));

    expect(body).toMatchObject({ Recurrent: "Y", DATA: { QR: "true" } });
    const { Token, DATA, ...scalars } = body;
    expect(computeToken(scalars, cfg.password)).toBe(Token);
    expect(DATA).toBeDefined();
  });
});

describe("GetQrBankList и BankId в AddAccountQr", () => {
  async function capture(
    fn: () => Promise<unknown>,
    response: Record<string, unknown> = { Success: true },
  ): Promise<{ url: string; body: Record<string, unknown> }> {
    let url = "";
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (calledUrl: string, init?: RequestInit) => {
      url = String(calledUrl);
      body = JSON.parse(String(init?.body));
      return { json: async () => response };
    }));
    await fn();
    return { url, body };
  }

  it("запрашивает сценарий привязки счёта и держит Device вне подписи", async () => {
    // Device — вложенный объект: уходит в теле, но не в токене. Ровно та же
    // граница, что у DATA/Receipt; нарушение даёт код 204 на каждый запрос.
    const { url, body } = await capture(() => tbankGetQrBankList(cfg, {
      deviceType: "mobile",
      deviceOs: "iOS 18",
    }));

    expect(url).toBe("https://tbank.test/v2/GetQrBankList");
    expect(body).toMatchObject({
      ScenarioType: "sub",
      PaymentMethod: "SBP",
      Device: { Type: "mobile", Os: "iOS 18" },
    });
    const { Token, Device, ...scalars } = body;
    expect(computeToken(scalars, cfg.password)).toBe(Token);
    expect(Device).toBeDefined();
  });

  it("подписывает BankId вместе с остальными полями AddAccountQr", async () => {
    const { body } = await capture(() => tbankAddAccountQr(cfg, {
      customerKey: "rider-1",
      description: "Привязка счёта СБП",
      bankId: "100000000004",
    }));

    expect(body).toMatchObject({ DataType: "PAYLOAD", BankId: "100000000004" });
    const { Token, ...scalars } = body;
    expect(computeToken(scalars, cfg.password)).toBe(Token);
  });

  it("не шлёт BankId, когда банк не выбран", async () => {
    const { body } = await capture(() => tbankAddAccountQr(cfg, {
      customerKey: "rider-1",
      description: "Привязка счёта СБП",
    }));

    expect(body).not.toHaveProperty("BankId");
    const { Token, ...scalars } = body;
    expect(computeToken(scalars, cfg.password)).toBe(Token);
  });

  it("не шлёт BankId вместе с DataType=IMAGE", async () => {
    // Deeplink возвращается только для PAYLOAD. С IMAGE поле было бы подписано
    // и отправлено впустую.
    const { body } = await capture(() => tbankAddAccountQr(cfg, {
      customerKey: "rider-1",
      description: "Привязка счёта СБП",
      dataType: "IMAGE",
      bankId: "100000000004",
    }));

    expect(body).toMatchObject({ DataType: "IMAGE" });
    expect(body).not.toHaveProperty("BankId");
  });
});

describe("normalizeSbpBanks", () => {
  it("читает форму, которую отдаёт боевой терминал (BankLogo)", () => {
    // Зафиксировано с прод-пробы sbp-banks-probe: логотип приезжает в BankLogo,
    // а не в LogoURL из первой версии парсера, из-за чего список рендерился
    // без иконок и без единой ошибки.
    const banks = normalizeSbpBanks({
      Success: true,
      ErrorCode: "0",
      BankList: [
        {
          BankId: "29c56d73-9646-4589-bd1f-8ce12dcfa0b3",
          NspkBankId: "100000000111",
          BankName: "Сбербанк",
          BankLogo: "https://sub.nspk.ru/proxyapp/logo/bank100000000111.png",
          BankOrder: 1,
        },
        {
          BankId: "208a3c2c-556a-45df-a0e9-bfc875a0b6c9",
          NspkBankId: "100000000004",
          BankName: "Т-Банк",
          BankLogo: "https://sub.nspk.ru/proxyapp/logo/bank100000000004.png",
          BankOrder: 2,
        },
      ],
    } as never);

    expect(banks).toHaveLength(2);
    expect(banks.every((b) => typeof b.logoUrl === "string")).toBe(true);
    expect(banks.find((b) => b.name === "Сбербанк")?.logoUrl).toBe(
      "https://sub.nspk.ru/proxyapp/logo/bank100000000111.png",
    );
  });

  it("читает документированную форму ответа", () => {
    const banks = normalizeSbpBanks({
      Success: true,
      BankList: [
        { BankId: "100000000004", BankName: "Т-Банк", LogoURL: "https://cdn.test/t.svg" },
        { BankId: "100000000111", BankName: "Сбербанк" },
      ],
    } as never);

    expect(banks).toEqual([
      { id: "100000000004", name: "Т-Банк", logoUrl: "https://cdn.test/t.svg" },
      { id: "100000000111", name: "Сбербанк" },
    ]);
  });

  it("читает вложенную форму с MemberId/MemberName", () => {
    // Ответ GetQrBankList не описан в документации T-Bank, и разные сборки
    // эквайринга отдавали список под разными ключами. Парсер обязан пережить
    // и такую форму, иначе пикер молча окажется пустым.
    const banks = normalizeSbpBanks({
      Success: true,
      Data: { Members: [{ MemberId: "100000000004", MemberName: "Т-Банк" }] },
    } as never);

    expect(banks).toEqual([{ id: "100000000004", name: "Т-Банк" }]);
  });

  it("возвращает пустой список на нераспознанной форме", () => {
    expect(normalizeSbpBanks({ Success: true } as never)).toEqual([]);
    expect(normalizeSbpBanks({ Success: false, ErrorCode: "3001" } as never)).toEqual([]);
  });

  it("отбрасывает элементы без id/имени и дубликаты", () => {
    const banks = normalizeSbpBanks({
      Success: true,
      BankList: [
        { BankId: "100000000004", BankName: "Т-Банк" },
        { BankId: "100000000004", BankName: "Т-Банк (дубль)" },
        { BankId: "100000000005" },
        { BankName: "Без id" },
        "мусор",
      ],
    } as never);

    expect(banks).toEqual([{ id: "100000000004", name: "Т-Банк" }]);
  });

  it("не пропускает id, который нельзя отдать эквайреру, и небезопасный логотип", () => {
    // id уходит в подписанный запрос, а logoUrl — прямо в src картинки.
    const banks = normalizeSbpBanks({
      Success: true,
      BankList: [
        { BankId: "плохой id", BankName: "Банк 1" },
        { BankId: "100000000004", BankName: "Банк 2", LogoURL: "javascript:alert(1)" },
        { BankId: "100000000005", BankName: "Банк 3", LogoURL: "http://cdn.test/x.svg" },
      ],
    } as never);

    expect(banks).toEqual([
      { id: "100000000004", name: "Банк 2" },
      { id: "100000000005", name: "Банк 3" },
    ]);
  });

  it("поднимает массовые банки наверх, сохраняя порядок эквайрера внутри групп", () => {
    const banks = normalizeSbpBanks({
      Success: true,
      BankList: [
        { BankId: "1", BankName: "Банк Зета" },
        { BankId: "2", BankName: "Сбербанк" },
        { BankId: "3", BankName: "АО Альфа-Банк" },
        { BankId: "4", BankName: "Т-Банк" },
      ],
    } as never);

    expect(banks.map((b) => b.name)).toEqual([
      "Т-Банк",
      "Сбербанк",
      "АО Альфа-Банк",
      "Банк Зета",
    ]);
  });
});

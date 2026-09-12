import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicPaymentMethod } from "@shared/schema";
import {
  detectSbpDeviceType,
  isOpenablePayload,
  partitionPendingBindings,
  visiblePaymentMethods,
} from "./payment-methods/binding-utils";

// This project currently uses Node-only Vitest tests and does not include a DOM
// component-test environment. Keep the binding-state contract covered directly
// against the page source (plus its extracted binding-utils module, which
// now holds the polling/timeout implementation).
const pageSource = readFileSync(resolve(process.cwd(), "client/src/pages/PaymentMethodsPage.tsx"), "utf8");
const utilsSource = readFileSync(resolve(process.cwd(), "client/src/pages/payment-methods/binding-utils.ts"), "utf8");

describe("PaymentMethodsPage binding controls", () => {
  it("does not render the relocated consent or cancellation disclosures", () => {
    expect(pageSource).not.toContain("autoChargeConsent");
    expect(pageSource).not.toContain('data-testid="checkbox-autocharge-consent"');
    expect(pageSource).not.toContain('data-testid="text-autocharge-consent"');
    expect(pageSource).not.toContain('data-testid="text-autocharge-cancel-info"');
  });

  it("gates both binding buttons only while the page is busy", () => {
    const cardButton = pageSource.slice(
      pageSource.indexOf('data-testid="button-bind-card"') - 300,
      pageSource.indexOf('data-testid="button-bind-card"') + 100,
    );
    const sbpButton = pageSource.slice(
      pageSource.indexOf('data-testid="button-add-sbp"') - 300,
      pageSource.indexOf('data-testid="button-add-sbp"') + 100,
    );

    expect(cardButton).toContain("disabled={busy}");
    expect(sbpButton).toContain("disabled={busy}");
  });

  it("keeps pending binding methods out of the rendered methods list", () => {
    expect(pageSource).toContain("const visibleMethods = visiblePaymentMethods(methods)");
    expect(pageSource).toContain("{visibleMethods.map((m) => {");
    expect(pageSource).not.toContain("{methods.map((m) => {");
    expect(pageSource).not.toContain("button-refresh-");
    expect(pageSource).not.toContain("method-pending-hint-");
    expect(pageSource).not.toContain("Проверить статус");
  });

  it("hides every failed binding, including generic bank rejections", () => {
    const superseded = {
      id: 5,
      type: "card",
      label: "Карта (привязывается…)",
      status: "failed",
      lastErrorCode: "SUPERSEDED_BY_NEW_ATTEMPT",
    } as PublicPaymentMethod;
    const cancelled = {
      id: 6,
      type: "card",
      label: "Карта (привязывается…)",
      status: "failed",
      lastErrorCode: "BINDING_CANCELLED",
    } as PublicPaymentMethod;
    const authFail = {
      id: 7,
      type: "card",
      label: "Карта (привязывается…)",
      status: "failed",
      lastErrorCode: "AUTH_FAIL",
    } as PublicPaymentMethod;
    const noErrorCode = {
      id: 8,
      type: "card",
      label: "•••• 4242",
      status: "failed",
      lastErrorCode: null,
    } as PublicPaymentMethod;
    const active = {
      id: 9,
      type: "card",
      label: "•••• 4242",
      status: "active",
    } as PublicPaymentMethod;
    const pending = {
      id: 10,
      type: "sbp",
      label: "Счёт СБП (привязывается…)",
      status: "pending",
    } as PublicPaymentMethod;

    expect(visiblePaymentMethods([superseded, cancelled, authFail, noErrorCode, active, pending])).toEqual([active]);
  });

  it("always sorts an active SBP method above active cards, without reordering same-type methods", () => {
    const card1 = { id: 1, type: "card", label: "•••• 1111", status: "active" } as PublicPaymentMethod;
    const card2 = { id: 2, type: "card", label: "•••• 2222", status: "active" } as PublicPaymentMethod;
    const sbp = { id: 3, type: "sbp", label: "СБП", status: "active" } as PublicPaymentMethod;

    // SBP added last (newest) still floats to the top, ahead of both cards.
    expect(visiblePaymentMethods([card1, card2, sbp])).toEqual([sbp, card1, card2]);
    // Already-first SBP stays first; relative card order is untouched either way.
    expect(visiblePaymentMethods([sbp, card1, card2])).toEqual([sbp, card1, card2]);
  });

  it("does not render an inline bank-error detail", () => {
    expect(pageSource).not.toContain("method-error-");
    expect(pageSource).not.toContain("{m.status === \"failed\" && err && (");
  });

  it("does not show a toast for any terminal card-bind failure", () => {
    const fetchedFailureEffect = pageSource.slice(
      pageSource.indexOf("// A webhook can update the list"),
      pageSource.indexOf("// Start a real T-Bank card binding"),
    );
    const pollingFailureEffect = pageSource.slice(
      pageSource.indexOf("// Keep pending bindings out of the list"),
      pageSource.indexOf("// Привязка карты через отдельный ПОПАП"),
    );

    expect(fetchedFailureEffect).toContain('method.status === "failed"');
    expect(pollingFailureEffect).toContain('method.status === "failed"');
    expect(fetchedFailureEffect).not.toContain("toast.toast");
    expect(pollingFailureEffect).not.toContain("toast.toast");
    expect(pageSource).not.toContain('title: "Привязка не удалась"');
    expect(pageSource).not.toContain("shouldNotifyBindingFailure");
  });

  it("silently polls each supported pending binding route on a short fixed interval", () => {
    expect(pageSource).toContain("const PENDING_POLL_INTERVAL_MS = 1_500");
    expect(utilsSource).toContain('`/api/payments/tbank/refresh-bind-sbp/${method.id}`');
    expect(utilsSource).toContain('`/api/payment-methods/${method.id}/refresh`');
    expect(utilsSource).toContain('`/api/payments/tbank/refresh-bind/${method.id}`');
    expect(pageSource).toContain("window.setInterval(() => void poll(), PENDING_POLL_INTERVAL_MS)");
    expect(pageSource).toContain("queryClient.invalidateQueries({ queryKey: METHODS_KEY })");
  });

  it("uses the three-minute client timeout only as a non-speculative reconciliation safety net", () => {
    expect(utilsSource).toContain("const PENDING_BINDING_TIMEOUT_MS = 3 * 60 * 1_000");
    expect(utilsSource).toContain('if (method.status !== "pending") continue');
    expect(utilsSource).toContain("age !== null && age >= PENDING_BINDING_TIMEOUT_MS");
    expect(pageSource).toContain("Do not show a speculative");
    expect(pageSource).toContain("GetAddCardState/GetState");
    expect(utilsSource).toContain('apiRequest("DELETE", `/api/payment-methods/${method.id}?pendingOnly=1`)');
  });

  it("does not timeout-toast a fresh pending card on mount, even with an old active card", () => {
    const now = Date.now();
    const activeCard = {
      id: 1, type: "card", label: "•••• 4242", status: "active", createdAt: now - 86_400_000,
    } as PublicPaymentMethod;
    const freshPendingCard = {
      id: 2, type: "card", label: "Карта (привязывается…)", status: "pending", createdAt: now,
    } as PublicPaymentMethod;

    const { pollable, timedOut } = partitionPendingBindings([activeCard, freshPendingCard], now);

    expect(timedOut).toEqual([]);
    expect(pollable).toEqual([freshPendingCard]);
  });

  it("times out an old pending bind from its original createdAt even if polling refreshed updatedAt", () => {
    const now = Date.now();
    const repeatedlyPolledPendingCard = {
      id: 3,
      type: "card",
      label: "Карта (привязывается…)",
      status: "pending",
      createdAt: now - (3 * 60 * 1_000),
      // Mimics an old server version continuously touching this field.
      updatedAt: now,
    } as PublicPaymentMethod;

    const { pollable, timedOut } = partitionPendingBindings([repeatedlyPolledPendingCard], now);

    expect(pollable).toEqual([]);
    expect(timedOut).toEqual([repeatedlyPolledPendingCard]);
  });

  it("keeps a freshly-created pending bind pollable even if its updatedAt is old or absent", () => {
    const now = Date.now();
    const freshPendingCard = {
      id: 4,
      type: "card",
      label: "Карта (привязывается…)",
      status: "pending",
      createdAt: now - (2 * 60 * 1_000),
      updatedAt: now - (60 * 60 * 1_000),
    } as PublicPaymentMethod;

    const { pollable, timedOut } = partitionPendingBindings([freshPendingCard], now);

    expect(pollable).toEqual([freshPendingCard]);
    expect(timedOut).toEqual([]);
  });
});

describe("СБП: выбор банка", () => {
  it("считает открываемым и https, и банковскую схему", () => {
    expect(isOpenablePayload("https://qr.nspk.ru/AS1A0000")).toBe(true);
    expect(isOpenablePayload("bank100000000004://qr/AS1A0000")).toBe(true);
    expect(isOpenablePayload("  https://qr.nspk.ru/AS1A0000  ")).toBe(true);
  });

  it("не считает открываемой сырую строку СБП", () => {
    // Такой payload годится только для QR: попытка отдать его браузеру как
    // ссылку кончится ошибкой навигации вместо перехода в банк.
    expect(isOpenablePayload("AS1A0000ABCD")).toBe(false);
    expect(isOpenablePayload("")).toBe(false);
  });

  it("вне браузера считает устройство мобильным", () => {
    // SSR/тесты: список для мобильного устройства — безопасное умолчание,
    // deeplink из него всё равно открывается только по явному тапу.
    expect(detectSbpDeviceType()).toBe("mobile");
  });
});

describe("СБП: кнопка ведёт в список банков, а не сразу в QR", () => {
  it("тап по «Добавить счёт СБП» открывает модалку до вызова эквайрера", () => {
    // Регрессия исходного поведения: кнопка сразу дёргала bind-sbp и показывала
    // QR. Теперь она только открывает модалку — привязка стартует уже после
    // выбора банка, иначе deeplink выбранного банка получить неоткуда.
    const handler = pageSource.slice(
      pageSource.indexOf("const handleAddSbp = () => {"),
      pageSource.indexOf("const closeSbpModal = () => {"),
    );
    expect(handler).toContain("setSbpModalOpen(true)");
    expect(handler).not.toContain("bindSbpMut.mutate(");
  });

  it("модалка открыта по своему флагу, а не по наличию binding", () => {
    // Шаг выбора банка идёт до появления binding: привязка модалки к
    // `sbpBinding && (` вернула бы старый порядок «сначала QR».
    expect(pageSource).toContain("{sbpModalOpen && (");
    expect(pageSource).not.toContain("{sbpBinding && (");
  });

  it("автопереход в приложение банка — только по явному выбору и только на телефоне", () => {
    const onSuccess = pageSource.slice(
      pageSource.indexOf("onSuccess: ({ data, bank }) => {"),
      pageSource.indexOf("onError: (e: Error) =>\n      toast.toast({ title: \"Не удалось привязать счёт СБП\""),
    );
    expect(onSuccess).toContain(
      'if (bank && isOpenablePayload(data.qrPayload) && detectSbpDeviceType() === "mobile")',
    );
  });
});

describe("СБП: QR только по явной просьбе", () => {
  const modalSource = readFileSync(
    resolve(process.cwd(), "client/src/pages/payment-methods/SbpBindModal.tsx"),
    "utf8",
  );

  it("с выбранным банком QR скрыт за кнопкой", () => {
    // Райдера уже уводит deeplink; QR рядом с ним — вторая, противоречащая
    // инструкция для той же привязки.
    expect(modalSource).toContain("const showQr = binding !== null && (!binding.bankName || qrRevealed);");
    expect(modalSource).toContain('data-testid="button-sbp-reveal-qr"');
  });

  it("без банка QR остаётся основным экраном", () => {
    // QR-путь выбирают явной кнопкой, и на десктопе он единственный рабочий:
    // showQr должен быть истинным именно при отсутствии bankName.
    expect(modalSource).toMatch(/showQr\s*=\s*binding !== null && \(!binding\.bankName/);
  });

  it("раскрытый QR не переезжает на следующую попытку", () => {
    expect(modalSource).toContain("useEffect(() => setQrRevealed(false), [binding?.payload]);");
  });
});

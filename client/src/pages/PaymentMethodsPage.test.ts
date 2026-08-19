import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicPaymentMethod } from "@shared/schema";
import {
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
      pageSource.indexOf("// Привязка карты через МОДАЛЬНЫЙ iframe"),
    );

    expect(fetchedFailureEffect).toContain('method.status === "failed"');
    expect(pollingFailureEffect).toContain('method.status === "failed"');
    expect(fetchedFailureEffect).not.toContain("toast.toast");
    expect(pollingFailureEffect).not.toContain("toast.toast");
    expect(pageSource).not.toContain('title: "Привязка не удалась"');
    expect(pageSource).not.toContain("shouldNotifyBindingFailure");
  });

  it("silently polls each supported pending binding route every three seconds", () => {
    expect(pageSource).toContain("const PENDING_POLL_INTERVAL_MS = 3_000");
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

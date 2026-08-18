import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicPaymentMethod } from "@shared/schema";
import {
  partitionPendingBindings,
  visiblePaymentMethods,
} from "./PaymentMethodsPage";

// This project currently uses Node-only Vitest tests and does not include a DOM
// component-test environment. Keep the binding-state contract covered directly
// against the page source.
const source = readFileSync(resolve(process.cwd(), "client/src/pages/PaymentMethodsPage.tsx"), "utf8");

describe("PaymentMethodsPage binding controls", () => {
  it("does not render the relocated consent or cancellation disclosures", () => {
    expect(source).not.toContain("autoChargeConsent");
    expect(source).not.toContain('data-testid="checkbox-autocharge-consent"');
    expect(source).not.toContain('data-testid="text-autocharge-consent"');
    expect(source).not.toContain('data-testid="text-autocharge-cancel-info"');
  });

  it("gates both binding buttons only while the page is busy", () => {
    const cardButton = source.slice(
      source.indexOf('data-testid="button-bind-card"') - 300,
      source.indexOf('data-testid="button-bind-card"') + 100,
    );
    const sbpButton = source.slice(
      source.indexOf('data-testid="button-add-sbp"') - 300,
      source.indexOf('data-testid="button-add-sbp"') + 100,
    );

    expect(cardButton).toContain("disabled={busy}");
    expect(sbpButton).toContain("disabled={busy}");
  });

  it("keeps pending binding methods out of the rendered methods list", () => {
    expect(source).toContain("const visibleMethods = visiblePaymentMethods(methods)");
    expect(source).toContain("{visibleMethods.map((m) => {");
    expect(source).not.toContain("{methods.map((m) => {");
    expect(source).not.toContain("button-refresh-");
    expect(source).not.toContain("method-pending-hint-");
    expect(source).not.toContain("Проверить статус");
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
    expect(source).not.toContain("method-error-");
    expect(source).not.toContain("{m.status === \"failed\" && err && (");
  });

  it("does not show a toast for any terminal card-bind failure", () => {
    const fetchedFailureEffect = source.slice(
      source.indexOf("// A webhook can update the list"),
      source.indexOf("// Start a real T-Bank card binding"),
    );
    const pollingFailureEffect = source.slice(
      source.indexOf("// Keep pending bindings out of the list"),
      source.indexOf("// Привязка карты через МОДАЛЬНЫЙ iframe"),
    );

    expect(fetchedFailureEffect).toContain('method.status === "failed"');
    expect(pollingFailureEffect).toContain('method.status === "failed"');
    expect(fetchedFailureEffect).not.toContain("toast.toast");
    expect(pollingFailureEffect).not.toContain("toast.toast");
    expect(source).not.toContain('title: "Привязка не удалась"');
    expect(source).not.toContain("shouldNotifyBindingFailure");
  });

  it("silently polls each supported pending binding route every three seconds", () => {
    expect(source).toContain("const PENDING_POLL_INTERVAL_MS = 3_000");
    expect(source).toContain('`/api/payments/tbank/refresh-bind-sbp/${method.id}`');
    expect(source).toContain('`/api/payment-methods/${method.id}/refresh`');
    expect(source).toContain('`/api/payments/tbank/refresh-bind/${method.id}`');
    expect(source).toContain("window.setInterval(() => void poll(), PENDING_POLL_INTERVAL_MS)");
    expect(source).toContain("queryClient.invalidateQueries({ queryKey: METHODS_KEY })");
  });

  it("uses the three-minute client timeout only as a non-speculative reconciliation safety net", () => {
    expect(source).toContain("const PENDING_BINDING_TIMEOUT_MS = 3 * 60 * 1_000");
    expect(source).toContain('if (method.status !== "pending") continue');
    expect(source).toContain("age !== null && age >= PENDING_BINDING_TIMEOUT_MS");
    expect(source).toContain("Do not show a speculative");
    expect(source).toContain("GetAddCardState/GetState");
    expect(source).toContain('apiRequest("DELETE", `/api/payment-methods/${method.id}?pendingOnly=1`)');
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

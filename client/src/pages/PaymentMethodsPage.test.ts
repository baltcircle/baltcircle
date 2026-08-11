import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PaymentMethod } from "@shared/schema";
import { partitionPendingBindings } from "./PaymentMethodsPage";

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
    expect(source).toContain('const visibleMethods = methods.filter((method) => method.status !== "pending")');
    expect(source).toContain("{visibleMethods.map((m) => {");
    expect(source).not.toContain("{methods.map((m) => {");
    expect(source).not.toContain("button-refresh-");
    expect(source).not.toContain("method-pending-hint-");
    expect(source).not.toContain("Проверить статус");
  });

  it("silently polls each supported pending binding route every three seconds", () => {
    expect(source).toContain("const PENDING_POLL_INTERVAL_MS = 3_000");
    expect(source).toContain('`/api/payments/tbank/refresh-bind-sbp/${method.id}`');
    expect(source).toContain('`/api/payment-methods/${method.id}/refresh`');
    expect(source).toContain('`/api/payments/tbank/refresh-bind/${method.id}`');
    expect(source).toContain("window.setInterval(() => void poll(), PENDING_POLL_INTERVAL_MS)");
    expect(source).toContain("queryClient.invalidateQueries({ queryKey: METHODS_KEY })");
  });

  it("stops stale pending bindings after three minutes and reports failures once", () => {
    expect(source).toContain("const PENDING_BINDING_TIMEOUT_MS = 3 * 60 * 1_000");
    expect(source).toContain('if (method.status !== "pending") continue');
    expect(source).toContain("age !== null && age >= PENDING_BINDING_TIMEOUT_MS");
    expect(source).toContain("Не удалось подтвердить привязку карты. Попробуйте снова.");
    expect(source).toContain("notifiedBindingFailureIds");
    expect(source).toContain('title: "Привязка не удалась"');
  });

  it("does not timeout-toast a fresh pending card on mount, even with an old active card", () => {
    const now = Date.now();
    const activeCard = {
      id: 1, type: "card", label: "•••• 4242", status: "active", createdAt: now - 86_400_000,
    } as PaymentMethod;
    const freshPendingCard = {
      id: 2, type: "card", label: "Карта (привязывается…)", status: "pending", createdAt: now,
    } as PaymentMethod;

    const { pollable, timedOut } = partitionPendingBindings([activeCard, freshPendingCard], now);

    expect(timedOut).toEqual([]);
    expect(pollable).toEqual([freshPendingCard]);
  });
});

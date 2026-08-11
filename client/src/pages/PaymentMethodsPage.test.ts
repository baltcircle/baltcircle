import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// This project currently uses Node-only Vitest tests and does not include a DOM
// component-test environment. Keep the compliance UI contract covered directly
// against the page source: the consent starts unchecked and both binding actions
// stay unavailable until its controlled state is true.
const source = readFileSync(resolve(process.cwd(), "client/src/pages/PaymentMethodsPage.tsx"), "utf8");

describe("PaymentMethodsPage auto-charge consent", () => {
  it("renders a controlled consent checkbox that is unchecked by default", () => {
    expect(source).toContain("const [autoChargeConsent, setAutoChargeConsent] = useState(false);");
    expect(source).toContain('data-testid="checkbox-autocharge-consent"');
    expect(source).toContain("checked={autoChargeConsent}");
    expect(source).toContain("onCheckedChange={(checked) => setAutoChargeConsent(checked === true)}");
  });

  it("shows the auto-charge amount and periodicity disclosure before binding actions", () => {
    const normalized = source.replace(/\s+/g, " ");

    expect(normalized).toContain(
      "Соглашаюсь на автоматическое списание банком стоимости поездки: оплата выбранного тарифа при старте поездки и, при превышении оплаченного времени, доплата по поминутному тарифу при завершении поездки. Фиксированной подписки и периодичности нет — сумма каждый раз зависит от тарифа и длительности конкретной поездки.",
    );
    expect(source.indexOf('data-testid="checkbox-autocharge-consent"')).toBeLessThan(
      source.indexOf('data-testid="button-bind-card"'),
    );
  });

  it("shows how to revoke auto-charge consent next to the linked methods", () => {
    const normalized = source.replace(/\s+/g, " ");

    expect(source).toContain('data-testid="text-autocharge-cancel-info"');
    expect(normalized).toContain(
      "Вы можете в любой момент отозвать согласие на автоматическое списание — нажмите «Отвязать карту» напротив нужной карты. После отвязки автоматическое списание по этой карте прекращается.",
    );
    expect(source.indexOf('data-testid="card-linked-methods"')).toBeLessThan(
      source.indexOf('data-testid="text-autocharge-cancel-info"'),
    );
  });

  it("keeps both binding buttons disabled until the rider checks consent", () => {
    const cardButton = source.slice(
      source.indexOf('data-testid="button-bind-card"') - 300,
      source.indexOf('data-testid="button-bind-card"') + 100,
    );
    const sbpButton = source.slice(
      source.indexOf('data-testid="button-add-sbp"') - 300,
      source.indexOf('data-testid="button-add-sbp"') + 100,
    );

    expect(cardButton).toContain("disabled={busy || !autoChargeConsent}");
    expect(sbpButton).toContain("disabled={busy || !autoChargeConsent}");
  });
});

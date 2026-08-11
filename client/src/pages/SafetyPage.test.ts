import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/SafetyPage.tsx"), "utf8");
const normalized = source.replace(/\s+/g, " ");

describe("SafetyPage auto-charge information", () => {
  it("renders the dedicated auto-charge section with adjacent how-it-works and cancellation paragraphs", () => {
    expect(source).toContain('data-testid="section-autocharge-info"');
    expect(source).toContain('data-testid="text-autocharge-info-how-it-works"');
    expect(source).toContain('data-testid="text-autocharge-info-cancel"');
    expect(normalized).toContain(
      "Стоимость выбранного тарифа списывается при старте поездки, а при превышении оплаченного времени доплата по поминутному тарифу списывается при завершении поездки. Фиксированной подписки и периодичности списаний нет — сумма каждый раз зависит от тарифа и длительности конкретной поездки.",
    );
    expect(normalized).toContain(
      "Вы можете в любой момент отозвать согласие на автоматическое списание — отвяжите карту на странице",
    );
    expect(source).toContain('href="/legal#terms"');
    expect(source).toContain('href="/payment-methods"');
  });
});

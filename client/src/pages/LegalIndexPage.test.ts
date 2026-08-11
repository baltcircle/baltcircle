import { describe, expect, it } from "vitest";
import { getLegalDoc } from "@/lib/legal";

const AUTOCHARGE_TERMS_TEXT =
  "Регистрируясь в Сервисе и принимая настоящее Пользовательское соглашение, Пользователь даёт согласие на автоматическое списание банком стоимости поездки: оплата выбранного тарифа списывается при старте поездки, а при превышении оплаченного времени — доплата по поминутному тарифу списывается при завершении поездки. Фиксированной подписки и периодичности списаний нет — сумма каждый раз зависит от тарифа и длительности конкретной поездки.";

describe("LegalIndexPage user agreement", () => {
  it("includes the auto-charge consent paragraph in the terms rendered at /legal#terms", () => {
    const terms = getLegalDoc("terms");

    expect(terms?.sections.flatMap((section) => section.paragraphs ?? [])).toContain(
      AUTOCHARGE_TERMS_TEXT,
    );
  });
});

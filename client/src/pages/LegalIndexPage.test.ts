import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getLegalDoc } from "@/lib/legal";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/LegalIndexPage.tsx"), "utf8");

const AUTOCHARGE_TERMS_TEXT =
  "Регистрируясь в Сервисе и принимая настоящее Пользовательское соглашение, Пользователь даёт согласие на автоматическое списание банком стоимости поездки: оплата выбранного тарифа списывается при старте поездки, а при превышении оплаченного времени — доплата по поминутному тарифу списывается при завершении поездки. Фиксированной подписки и периодичности списаний нет — сумма каждый раз зависит от тарифа и длительности конкретной поездки.";

describe("LegalIndexPage user agreement", () => {
  it("includes the auto-charge consent paragraph in the terms rendered at /legal#terms", () => {
    const terms = getLegalDoc("terms");

    expect(terms?.sections.flatMap((section) => section.paragraphs ?? [])).toContain(
      AUTOCHARGE_TERMS_TEXT,
    );
  });

  it("scrolls internal anchors without adding browser history entries", () => {
    expect(source).toContain("function scrollToAnchor");
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain('document.getElementById(anchor)?.scrollIntoView({ block: "start" });');
    expect(source).not.toContain("history.pushState");
    expect(source).not.toContain("navigate(");
    expect(source.match(/onClick=\{scrollToAnchor\}/g)).toHaveLength(2);
  });
});

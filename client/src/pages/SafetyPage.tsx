import { useEffect, type MouseEvent } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { INFO_CATEGORIES, PRIVACY_DOCS, RIDING_DOCS } from "@/lib/info";
import { InfoDocument } from "./safety/InfoDocument";
import { LegalSection } from "./safety/LegalSection";

const RIDING_CATEGORY = INFO_CATEGORIES.find((category) => category.slug === "riding")!;
const PRIVACY_CATEGORY = INFO_CATEGORIES.find((category) => category.slug === "privacy")!;

const LEGAL_INLINE_REFERENCES = [
  { text: "Правилах проката велосипедов", anchor: "legal-rental-rules" },
  { text: "документе «Условия оплаты»", anchor: "legal-payment-terms" },
  { text: "Политикой конфиденциальности", anchor: "legal-privacy" },
  { text: "Согласия на обработку персональных данных", anchor: "legal-consent" },
] as const;

const INFO_INLINE_REFERENCES = [
  { text: "«Условия оплаты»", anchor: "legal-payment-terms" },
  { text: "«Политике конфиденциальности»", anchor: "legal-privacy" },
  { text: "«Правовые документы»", anchor: "legal" },
] as const;

// Same-page links must only scroll. Letting the browser follow `#anchor` would
// append an entry to history for every click, requiring extra Back presses.
function scrollToAnchor(event: MouseEvent<HTMLAnchorElement>) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  event.preventDefault();
  const anchor = event.currentTarget.hash.slice(1);
  document.getElementById(anchor)?.scrollIntoView({ block: "start" });
}

function renderParagraph(
  paragraph: string,
  references: readonly { text: string; anchor: string }[],
) {
  const foundReferences = references
    .map((reference) => ({ ...reference, index: paragraph.indexOf(reference.text) }))
    .filter((reference) => reference.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (foundReferences.length === 0) return paragraph;

  let cursor = 0;
  return (
    <>
      {foundReferences.map((reference) => {
        const before = paragraph.slice(cursor, reference.index);
        cursor = reference.index + reference.text.length;
        return (
          <span key={reference.anchor}>
            {before}
            <a
              href={`#${reference.anchor}`}
              onClick={scrollToAnchor}
              className="text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
            >
              {reference.text}
            </a>
          </span>
        );
      })}
      {paragraph.slice(cursor)}
    </>
  );
}

// Единая страница «Информация» (/safety). Материалы о безопасной поездке,
// данных и юридические документы остаются в исходной последовательности и
// отображаются в одном прокручиваемом оверлее.
export function SafetyPage() {
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchor) return;

    requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: "start" });
    });
  }, []);

  return (
    <OverlayShell title="Информация">
      <div className="px-4 py-6 max-w-2xl mx-auto" data-testid="page-safety">
        <nav
          aria-label="Содержание раздела информации"
          className="mb-8"
        >
          <ul className="space-y-5 list-none">
            <li>
              <a
                href="#riding"
                onClick={scrollToAnchor}
                data-testid="link-info-riding"
                className="text-xl font-medium leading-snug text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                Безопасная поездка
              </a>
            </li>
            <li>
              <a
                href="#privacy"
                onClick={scrollToAnchor}
                data-testid="link-info-privacy"
                className="text-xl font-medium leading-snug text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                Конфиденциальность и данные
              </a>
            </li>
            <li>
              <a
                href="#autocharge-info"
                onClick={scrollToAnchor}
                data-testid="link-info-autocharge"
                className="text-xl font-medium leading-snug text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                Оплата и автосписание
              </a>
            </li>
            <li>
              <a
                href="#legal"
                onClick={scrollToAnchor}
                data-testid="link-info-legal"
                className="text-xl font-medium leading-snug text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                Правовые документы
              </a>
            </li>
          </ul>
        </nav>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-10 text-sm leading-relaxed">
          <section id="riding" data-testid="section-info-riding" className="scroll-mt-6">
            <h2 className="font-display text-xl font-light">Безопасная поездка</h2>
            <p className="text-muted-foreground mt-1">{RIDING_CATEGORY.description}</p>
            <p>{RIDING_CATEGORY.intro}</p>
            <div className="space-y-8 mt-6">
              {RIDING_DOCS.map((doc) => (
                <InfoDocument
                  key={doc.slug}
                  doc={doc}
                  category="riding"
                  renderParagraph={(p) => renderParagraph(p, INFO_INLINE_REFERENCES)}
                />
              ))}
            </div>
          </section>

          <section id="privacy" data-testid="section-info-privacy" className="scroll-mt-6">
            <h2 className="font-display text-xl font-light">Конфиденциальность и данные</h2>
            <p className="text-muted-foreground mt-1">{PRIVACY_CATEGORY.description}</p>
            <p>{renderParagraph(PRIVACY_CATEGORY.intro, INFO_INLINE_REFERENCES)}</p>
            <div className="space-y-8 mt-6">
              {PRIVACY_DOCS.map((doc) => (
                <InfoDocument
                  key={doc.slug}
                  doc={doc}
                  category="privacy"
                  renderParagraph={(p) => renderParagraph(p, INFO_INLINE_REFERENCES)}
                />
              ))}
            </div>
          </section>

          <section
            id="autocharge-info"
            data-testid="section-autocharge-info"
            className="scroll-mt-6"
          >
            <h2 className="font-display text-xl font-light">Автосписание за поездку</h2>
            <p data-testid="text-autocharge-info-how-it-works">
              Стоимость выбранного тарифа списывается при старте поездки, а при превышении
              оплаченного времени доплата по поминутному тарифу списывается при завершении
              поездки. Фиксированной подписки и периодичности списаний нет — сумма каждый раз
              зависит от тарифа и длительности конкретной поездки. Подробнее — в{" "}
              <a
                href="/legal#terms"
                className="text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                Пользовательском соглашении
              </a>
              .
            </p>
            <p data-testid="text-autocharge-info-cancel">
              Вы можете в любой момент отозвать согласие на автоматическое списание — отвяжите
              карту на странице{" "}
              <a
                href="/payment-methods"
                className="text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                «Способы оплаты»
              </a>{" "}
              (кнопка «Отвязать карту» напротив нужной карты). После отвязки автоматическое
              списание по этой карте прекращается.
            </p>
          </section>

          <LegalSection renderParagraph={(p) => renderParagraph(p, LEGAL_INLINE_REFERENCES)} />
        </div>
      </div>
    </OverlayShell>
  );
}

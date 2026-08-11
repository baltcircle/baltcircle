import { useEffect } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { INFO_CATEGORIES, PRIVACY_DOCS, RIDING_DOCS, type InfoDoc } from "@/lib/info";
import { LEGAL_DOCS } from "@/lib/legal";

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

function InfoDocument({ doc, category }: { doc: InfoDoc; category: "riding" | "privacy" }) {
  const anchor = `${category}-${doc.slug}`;

  return (
    <section
      id={anchor}
      data-testid={`section-info-${anchor}`}
      className="scroll-mt-6"
    >
      <h3 className="font-display text-lg font-light">{doc.title}</h3>
      <p className="text-muted-foreground mt-1">{doc.description}</p>

      {doc.sections.map((section, index) => (
        <section key={index} className="mt-5">
          {section.heading && (
            <h4 className="font-display text-base font-light">{section.heading}</h4>
          )}
          {section.paragraphs?.map((paragraph, paragraphIndex) => (
            <p key={paragraphIndex}>{renderParagraph(paragraph, INFO_INLINE_REFERENCES)}</p>
          ))}
          {section.bullets && (
            <ul>
              {section.bullets.map((bullet, bulletIndex) => (
                <li key={bulletIndex}>{bullet}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </section>
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
        <header className="mb-6">
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
            Информация
          </div>
          <h1 className="font-display text-xl font-light leading-tight mt-1">
            Безопасность, данные и правовые документы
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            Здесь собраны рекомендации по безопасной поездке, информация о данных и полные
            тексты правовых документов TakeRide.
          </p>
        </header>

        <nav
          aria-label="Содержание раздела информации"
          className="mb-8"
        >
          <ul className="space-y-5 list-none">
            <li>
              <a
                href="#riding"
                data-testid="link-info-riding"
                className="text-xl font-medium leading-snug text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                Безопасная поездка
              </a>
            </li>
            <li>
              <a
                href="#privacy"
                data-testid="link-info-privacy"
                className="text-xl font-medium leading-snug text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                Конфиденциальность и данные
              </a>
            </li>
            <li>
              <a
                href="#legal"
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
                <InfoDocument key={doc.slug} doc={doc} category="riding" />
              ))}
            </div>
          </section>

          <section id="privacy" data-testid="section-info-privacy" className="scroll-mt-6">
            <h2 className="font-display text-xl font-light">Конфиденциальность и данные</h2>
            <p className="text-muted-foreground mt-1">{PRIVACY_CATEGORY.description}</p>
            <p>{renderParagraph(PRIVACY_CATEGORY.intro, INFO_INLINE_REFERENCES)}</p>
            <div className="space-y-8 mt-6">
              {PRIVACY_DOCS.map((doc) => (
                <InfoDocument key={doc.slug} doc={doc} category="privacy" />
              ))}
            </div>
          </section>

          <section id="legal" data-testid="section-info-legal" className="scroll-mt-6">
            <h2 className="font-display text-xl font-light">Правовые документы</h2>
            <p className="text-muted-foreground mt-1">
              Соглашение, правила проката, конфиденциальность, оплата
            </p>

            <div className="space-y-10 mt-6">
              {LEGAL_DOCS.map((doc) => (
                <section
                  key={doc.slug}
                  id={`legal-${doc.slug}`}
                  data-testid={`section-info-legal-${doc.slug}`}
                  className="scroll-mt-6"
                >
                  <h3 className="font-display text-lg font-light">{doc.title}</h3>
                  <p className="text-muted-foreground mt-1">{doc.description}</p>

                  {doc.sections.map((section, index) => (
                    <section key={index} className="mt-5">
                      {section.heading && (
                        <h4 className="font-display text-base font-light">{section.heading}</h4>
                      )}
                      {section.paragraphs?.map((paragraph, paragraphIndex) => (
                        <p key={paragraphIndex}>
                          {renderParagraph(paragraph, LEGAL_INLINE_REFERENCES)}
                        </p>
                      ))}
                      {section.bullets && (
                        <ul>
                          {section.bullets.map((bullet, bulletIndex) => (
                            <li key={bulletIndex}>{bullet}</li>
                          ))}
                        </ul>
                      )}
                    </section>
                  ))}
                </section>
              ))}
            </div>
          </section>
        </div>
      </div>
    </OverlayShell>
  );
}

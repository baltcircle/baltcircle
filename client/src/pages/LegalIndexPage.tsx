import { useEffect } from "react";
import { OverlayShell } from "@/components/OverlayShell";
import { LEGAL_DOCS } from "@/lib/legal";

const DOCUMENT_LINKS = [
  { slug: "terms", title: "Пользовательское соглашение" },
  { slug: "rental-rules", title: "Правила проката велосипедов" },
  { slug: "privacy", title: "Политика конфиденциальности" },
  { slug: "consent", title: "Согласие на обработку персональных данных" },
  { slug: "payment-terms", title: "Условия оплаты" },
] as const;

const INLINE_REFERENCES = [
  { text: "Правилах проката велосипедов", anchor: "rental-rules" },
  { text: "документе «Условия оплаты»", anchor: "payment-terms" },
  { text: "Политикой конфиденциальности", anchor: "privacy" },
  { text: "Согласия на обработку персональных данных", anchor: "consent" },
] as const;

function renderParagraph(paragraph: string) {
  const references = INLINE_REFERENCES
    .map((reference) => ({ ...reference, index: paragraph.indexOf(reference.text) }))
    .filter((reference) => reference.index >= 0)
    .sort((a, b) => a.index - b.index);

  if (references.length === 0) return paragraph;

  let cursor = 0;
  return (
    <>
      {references.map((reference) => {
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

// Единая страница «Правовые документы» (/legal). Все документы остаются
// в исходной последовательности и отображаются в одном прокручиваемом оверлее.
export function LegalIndexPage() {
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchor) return;

    requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: "start" });
    });
  }, []);

  return (
    <OverlayShell title="Правовые документы">
      <div className="px-4 py-6 max-w-2xl mx-auto" data-testid="page-legal">
        <header className="mb-6">
          <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
            Правовые документы
          </div>
          <h1 className="font-display text-xl font-light leading-tight mt-1">
            Условия использования сервиса TakeRide
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            Редакция MVP. Дата вступления в силу: при запуске сервиса.
          </p>
        </header>

        <nav
          aria-label="Содержание правовых документов"
          className="rounded-2xl border border-card-border bg-card px-4 py-4 mb-8"
        >
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground mb-2">
            Содержание
          </div>
          <ol className="space-y-2 text-sm">
            {DOCUMENT_LINKS.map((document, index) => (
              <li key={document.slug}>
                <a
                  href={`#${document.slug}`}
                  data-testid={`link-legal-${document.slug}`}
                  className="text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
                >
                  {index + 1}. {document.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-10 text-sm leading-relaxed">
          {LEGAL_DOCS.map((doc) => (
            <section
              key={doc.slug}
              id={doc.slug}
              data-testid={`section-legal-${doc.slug}`}
              className="scroll-mt-6"
            >
              <h2 className="font-display text-xl font-light">{doc.title}</h2>
              <p className="text-muted-foreground mt-1">{doc.description}</p>

              {doc.sections.map((section, index) => (
                <section key={index} className="mt-5">
                  {section.heading && (
                    <h3 className="font-display text-lg font-light">{section.heading}</h3>
                  )}
                  {section.paragraphs?.map((paragraph, paragraphIndex) => (
                    <p key={paragraphIndex}>{renderParagraph(paragraph)}</p>
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

              {doc.reviewNote && (
                <p
                  className="text-xs text-muted-foreground border-t border-card-border pt-4 mt-6"
                  data-testid={`text-legal-${doc.slug}-review-note`}
                >
                  {doc.reviewNote}
                </p>
              )}
            </section>
          ))}
        </div>
      </div>
    </OverlayShell>
  );
}

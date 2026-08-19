import type { ReactNode } from "react";
import { LEGAL_DOCS } from "@/lib/legal";

export function LegalSection({
  renderParagraph,
}: {
  renderParagraph: (paragraph: string) => ReactNode;
}) {
  return (
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
                    {renderParagraph(paragraph)}
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
  );
}

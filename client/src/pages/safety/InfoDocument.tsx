import type { ReactNode } from "react";
import type { InfoDoc } from "@/lib/info";

export function InfoDocument({
  doc, category, renderParagraph,
}: {
  doc: InfoDoc;
  category: "riding" | "privacy";
  renderParagraph: (paragraph: string) => ReactNode;
}) {
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
    </section>
  );
}

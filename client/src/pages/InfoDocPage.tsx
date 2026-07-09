import { OverlayShell } from "@/components/OverlayShell";
import { getInfoDoc } from "@/lib/info";
import NotFound from "@/pages/not-found";

// Полный текст одной подтемы «Информации» (/safety/<section>/<slug>).
// Аналог LegalDocPage: заголовок с иконкой, вводный параграф с описанием,
// набор секций (heading + paragraphs + bullets).
export function InfoDocPage({ section, slug }: { section: string; slug: string }) {
  const found = getInfoDoc(section, slug);
  if (!found) return <NotFound />;
  const { category, doc } = found;
  const Icon = doc.icon;

  return (
    <OverlayShell title={doc.title}>
      <div
        className="px-4 py-6 max-w-2xl mx-auto"
        data-testid={`page-info-${category.slug}-${doc.slug}`}
      >
        <header className="mb-5 flex items-center gap-3">
          <span className="flex items-center justify-center w-11 h-11 rounded-full bg-muted text-muted-foreground shrink-0">
            <Icon className="w-6 h-6" />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              {category.shortTitle}
            </div>
            <h1 className="font-display text-xl font-light leading-tight">{doc.title}</h1>
            {doc.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{doc.description}</p>
            )}
          </div>
        </header>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-5 text-sm leading-relaxed">
          {doc.sections.map((section, i) => (
            <section key={i}>
              {section.heading && (
                <h2 className="font-display text-lg font-light">{section.heading}</h2>
              )}
              {section.paragraphs?.map((p, j) => (
                <p key={j}>{p}</p>
              ))}
              {section.bullets && (
                <ul>
                  {section.bullets.map((b, j) => (
                    <li key={j}>{b}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </div>
    </OverlayShell>
  );
}

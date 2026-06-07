import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { getLegalDoc, type LegalDoc } from "@/lib/legal";
import NotFound from "@/pages/not-found";

export function LegalDocPage({ slug }: { slug: string }) {
  const doc = getLegalDoc(slug);
  if (!doc) return <NotFound />;
  return <LegalDoc doc={doc} />;
}

function LegalDoc({ doc }: { doc: LegalDoc }) {
  const Icon = doc.icon;
  return (
    <div className="min-h-full bg-background" data-testid={`page-legal-${doc.slug}`}>
      <div className="mx-auto max-w-2xl px-5 pt-6 pb-16">
        <header className="mb-6 flex items-center gap-3">
          <Link
            href="/legal"
            data-testid={`link-legal-${doc.slug}-back`}
            aria-label="К списку документов"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground hover-elevate shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              BaltCircle
            </div>
            <h1 className="font-display text-2xl font-light leading-tight flex items-center gap-2">
              <Icon className="w-5 h-5 shrink-0" /> {doc.title}
            </h1>
          </div>
        </header>

        <div className="prose prose-sm dark:prose-invert max-w-none space-y-5 text-sm leading-relaxed">
          <p className="text-muted-foreground">Редакция MVP. Дата вступления в силу: при запуске сервиса.</p>

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

          {doc.reviewNote && (
            <p
              className="text-xs text-muted-foreground border-t border-card-border pt-4"
              data-testid={`text-legal-${doc.slug}-review-note`}
            >
              {doc.reviewNote}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

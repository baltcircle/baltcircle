import { Link } from "wouter";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { LEGAL_DOCS, LEGAL_INDEX_ICON } from "@/lib/legal";

export function LegalIndexPage() {
  return (
    <div className="min-h-full bg-background" data-testid="page-legal">
      <div className="mx-auto max-w-2xl px-5 pt-6 pb-16">
        <header className="mb-6 flex items-center gap-3">
          <Link
            href="/profile"
            data-testid="link-legal-back"
            aria-label="Назад в профиль"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground hover-elevate shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
              BaltCircle
            </div>
            <h1 className="font-display text-2xl font-light leading-tight flex items-center gap-2">
              <LEGAL_INDEX_ICON className="w-5 h-5" /> Правовые документы
            </h1>
          </div>
        </header>

        <p className="text-sm text-muted-foreground mb-4 px-1">
          Условия использования сервиса, правила проката и обработка персональных данных.
        </p>

        <nav className="rounded-2xl border border-card-border bg-card overflow-hidden divide-y divide-card-border">
          {LEGAL_DOCS.map((doc) => {
            const Icon = doc.icon;
            return (
              <Link
                key={doc.slug}
                href={`/legal/${doc.slug}`}
                data-testid={`link-legal-${doc.slug}`}
                className="flex items-center gap-3 px-4 py-4 hover-elevate"
              >
                <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
                  <Icon className="w-5 h-5" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-light">{doc.title}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">{doc.description}</span>
                </span>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

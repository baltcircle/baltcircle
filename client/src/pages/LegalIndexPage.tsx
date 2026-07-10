import { Link } from "wouter";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { LEGAL_DOCS } from "@/lib/legal";

// Шапка приведена к тому же виду, что и у остальных подразделов «Информации»
// (InfoSectionPage через OverlayShell): sticky-хедер с кнопкой «Назад» слева
// и заголовком по центру. LegalIndexPage — обычная страница, а не overlay,
// поэтому «Назад» ведёт напрямую в профиль через <Link>.
export function LegalIndexPage() {
  return (
    <div className="flex flex-col bg-background text-foreground min-h-full" data-testid="page-legal">
      {/* Header (mirrors OverlayShell) */}
      <div
        className="relative flex items-center justify-center shrink-0 border-b border-border bg-background"
        style={{ paddingTop: "env(safe-area-inset-top)", minHeight: "calc(3.5rem + env(safe-area-inset-top))" }}
      >
        <Link
          href="/profile"
          data-testid="link-legal-back"
          aria-label="Назад"
          className="absolute left-4 flex items-center justify-center w-9 h-9 rounded-full hover:bg-muted transition-colors"
          style={{ top: "calc(env(safe-area-inset-top) + 0.625rem)" }}
        >
          <ArrowLeft className="w-5 h-5 text-foreground" />
        </Link>
        <div className="text-center" style={{ marginTop: "env(safe-area-inset-top)" }}>
          <h1 className="text-base font-semibold text-foreground">Правовые документы</h1>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-6 max-w-2xl mx-auto">
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
    </div>
  );
}

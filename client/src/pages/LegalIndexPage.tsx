import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { OverlayShell } from "@/components/OverlayShell";
import { LEGAL_DOCS } from "@/lib/legal";

// Хаб «Правовые документы» (/legal). Оформлен как остальные подразделы
// «Информации» — через OverlayShell со стандартной шапкой и кнопкой
// «Назад», которая работает через overlay:back (см. OverlayRouter).
export function LegalIndexPage() {
  return (
    <OverlayShell title="Правовые документы">
      <div className="px-4 py-6 max-w-2xl mx-auto" data-testid="page-legal">
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
    </OverlayShell>
  );
}

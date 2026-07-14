import { Link } from "wouter";
import { OverlayShell } from "@/components/OverlayShell";
import { INFO_CATEGORIES } from "@/lib/info";
import { Scale, ChevronRight } from "lucide-react";

// Хаб «Информация». Три пункта: две информационные категории (Безопасная
// поездка, Конфиденциальность и данные) — обе живут под /safety/<category>
// и рендерятся InfoSectionPage / InfoDocPage. Третий пункт — «Правовые
// документы» — ведёт на существующий /legal с юридически обязывающими
// текстами (LegalIndexPage / LegalDocPage).
export function SafetyPage() {
  return (
    <OverlayShell title="Информация">
      <div className="px-4 py-6 max-w-2xl mx-auto" data-testid="page-safety">
        <nav className="rounded-2xl border border-card-border bg-card overflow-hidden divide-y divide-card-border">
          {INFO_CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            return (
              <Link
                key={cat.slug}
                href={`/safety/${cat.slug}`}
                data-testid={`link-info-${cat.slug}`}
                className="flex items-center gap-3 px-4 py-4 hover-elevate"
              >
                <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
                  <Icon className="w-5 h-5" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-light">{cat.title}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {cat.description}
                  </span>
                </span>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </Link>
            );
          })}

          <Link
            href="/legal"
            data-testid="link-info-legal"
            className="flex items-center gap-3 px-4 py-4 hover-elevate"
          >
            <span className="flex items-center justify-center w-9 h-9 rounded-full bg-muted text-muted-foreground shrink-0">
              <Scale className="w-5 h-5" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block font-light">Правовые документы</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                Соглашение, правила проката, конфиденциальность, оплата
              </span>
            </span>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </Link>
        </nav>
      </div>
    </OverlayShell>
  );
}

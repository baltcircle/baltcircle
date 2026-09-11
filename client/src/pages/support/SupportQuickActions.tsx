import { Button } from "@/components/ui/button";
import { CheckCircle2, Headset, Loader2 } from "lucide-react";

/**
 * Две кнопки-«пузыря», всплывающие после каждого автоответа бота, пока
 * разговор ещё не передан оператору: «Вопрос решён» тихо закрывает раунд
 * (без уведомления админки), «Позвать оператора» — явная эскалация с
 * уведомлением. Показываются условно из SupportPage (см. showQuickActions).
 */
export function SupportQuickActions({
  onResolve, onEscalate, resolving, escalating,
}: {
  onResolve: () => void;
  onEscalate: () => void;
  resolving: boolean;
  escalating: boolean;
}) {
  const disabled = resolving || escalating;
  return (
    <div className="flex justify-start" data-testid="support-quick-actions">
      <div className="flex flex-wrap gap-2 max-w-[80%]">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-full h-8 gap-1.5"
          onClick={onResolve}
          disabled={disabled}
          data-testid="button-support-resolve"
        >
          {resolving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          Вопрос решён
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-full h-8 gap-1.5"
          onClick={onEscalate}
          disabled={disabled}
          data-testid="button-support-escalate"
        >
          {escalating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Headset className="w-3.5 h-3.5" />}
          Позвать оператора
        </Button>
      </div>
    </div>
  );
}

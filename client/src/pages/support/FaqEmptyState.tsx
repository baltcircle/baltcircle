import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FAQ_HINT } from "./utils";

export function FaqEmptyState({
  onPickFaq, onCallOperator, disabled,
}: {
  onPickFaq: (q: string) => void;
  onCallOperator: () => void;
  disabled: boolean;
}) {
  return (
    <Card className="p-4 space-y-3">
      <div className="text-sm font-medium">Здравствуйте! Я бот поддержки TakeRide 🤖</div>
      <div className="text-xs text-muted-foreground leading-snug">
        Опишите вопрос своими словами — подскажу по аренде, оплате, зонам и типичным
        проблемам. Нужен живой сотрудник — нажмите «Позвать оператора» или напишите «оператор».
      </div>
      <div className="space-y-2 pt-1">
        {FAQ_HINT.map((f, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPickFaq(f.q)}
            disabled={disabled}
            className="block w-full text-left rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 hover:bg-muted/60 transition-colors disabled:opacity-50"
          >
            <div className="text-xs font-medium">{f.q}</div>
          </button>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full mt-1"
        onClick={onCallOperator}
        disabled={disabled}
      >
        Позвать оператора
      </Button>
    </Card>
  );
}

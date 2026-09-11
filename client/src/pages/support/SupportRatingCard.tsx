import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Star, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { errorMessage } from "@/lib/error-message";

interface Props {
  onDone: () => void;
}

/**
 * Оценка «Как вам работа поддержки» встроена прямо в поток чата как
 * обычный пузырь сообщения (не модальное окно) — SupportPage.tsx решает,
 * когда её рендерить, по совпадению последнего сообщения с
 * SUPPORT_SESSION_CLOSED_NOTE. Клик по звезде сразу отправляет оценку и
 * пузырь исчезает из чата; отдельной кнопки «Отправить» нет.
 */
export function SupportRatingCard({ onDone }: Props) {
  const toast = useToast();
  const [hoverRating, setHoverRating] = useState(0);

  const submitMut = useMutation({
    mutationFn: async (value: number) => (await apiRequest("POST", "/api/support/chat/feedback", { rating: value })).json(),
    onSuccess: () => {
      toast.toast({ title: "Спасибо за оценку!" });
      onDone();
    },
    onError: (err) => {
      toast.toast({
        title: "Не удалось отправить оценку",
        description: errorMessage(err, "Попробуйте ещё раз"),
        variant: "destructive",
      });
    },
  });

  return (
    <div className="flex justify-start" data-testid="support-rating-card">
      <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-muted px-3 py-2.5">
        <div className="text-[10px] font-medium opacity-70 mb-1.5">Поддержка</div>
        <div className="text-sm mb-2">Как вам работа поддержки?</div>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = n <= hoverRating;
            return (
              <button
                key={n}
                type="button"
                onClick={() => submitMut.mutate(n)}
                onMouseEnter={() => setHoverRating(n)}
                onMouseLeave={() => setHoverRating(0)}
                disabled={submitMut.isPending}
                data-testid={`button-support-rating-star-${n}`}
                aria-label={`Оценка ${n} из 5`}
                className="p-0.5 touch-manipulation disabled:opacity-50"
              >
                <Star
                  className={`w-6 h-6 transition-colors ${
                    filled ? "fill-primary text-primary" : "fill-none text-muted-foreground"
                  }`}
                />
              </button>
            );
          })}
          {submitMut.isPending && <Loader2 className="w-4 h-4 ml-1 animate-spin text-muted-foreground" />}
        </div>
      </div>
    </div>
  );
}

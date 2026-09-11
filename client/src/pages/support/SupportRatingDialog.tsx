import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Star, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { errorMessage } from "@/lib/error-message";
import { useToast } from "@/hooks/use-toast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Попап «Как вам работа поддержки» — всплывает у райдера сразу после того,
 * как оператор нажимает «Завершить сессию» (сигнал приходит через SSE-событие
 * support_session_closed, см. SupportPage.tsx). Только звёзды 1-5, без причин
 * и комментария — в отличие от RideFeedbackDialog. Как и там, полностью
 * пропускаемо: закрытие крестиком/фоном ничего не отправляет.
 */
export function SupportRatingDialog({ open, onOpenChange }: Props) {
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);

  const reset = () => {
    setRating(0);
    setHoverRating(0);
  };

  const submitMut = useMutation({
    mutationFn: async (value: number) => (await apiRequest("POST", "/api/support/chat/feedback", { rating: value })).json(),
    onSuccess: () => {
      toast.toast({ title: "Спасибо за оценку!" });
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.toast({
        title: "Не удалось отправить оценку",
        description: errorMessage(err, "Попробуйте ещё раз"),
        variant: "destructive",
      });
    },
  });

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitMut.isPending && handleOpenChange(v)}>
      <DialogContent data-testid="dialog-support-rating">
        <DialogHeader>
          <DialogTitle className="font-display font-light">Как вам работа поддержки?</DialogTitle>
        </DialogHeader>

        <div className="flex justify-center gap-1 py-4">
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = n <= (hoverRating || rating);
            return (
              <button
                key={n}
                type="button"
                onClick={() => setRating(n)}
                onMouseEnter={() => setHoverRating(n)}
                onMouseLeave={() => setHoverRating(0)}
                disabled={submitMut.isPending}
                data-testid={`button-support-rating-star-${n}`}
                aria-label={`Оценка ${n} из 5`}
                className="p-1 touch-manipulation"
              >
                <Star
                  className={`w-9 h-9 transition-colors ${
                    filled ? "fill-primary text-primary" : "fill-none text-muted-foreground"
                  }`}
                />
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button
            className="w-full"
            disabled={rating === 0 || submitMut.isPending}
            onClick={() => submitMut.mutate(rating)}
            data-testid="button-submit-support-rating"
          >
            {submitMut.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Отправляем…
              </>
            ) : (
              "Отправить"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

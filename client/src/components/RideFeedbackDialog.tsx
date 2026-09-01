import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Star, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { errorMessage } from "@/lib/error-message";
import { useToast } from "@/hooks/use-toast";
import { feedbackTierForRating, FEEDBACK_TIER_TITLES, FEEDBACK_REASONS } from "@shared/feedback";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rideId: number | null;
}

/**
 * Диалог после завершения поездки: рейтинг 1-5 звёзд, затем пул причин,
 * зависящий от тарифной группы рейтинга (см. shared/feedback.ts). Всегда
 * пропускаем без давления — закрытие в любой момент (крестик/фон) не считается
 * ошибкой и ничего не отправляет.
 */
export function RideFeedbackDialog({ open, onOpenChange, rideId }: Props) {
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [reasons, setReasons] = useState<string[]>([]);
  const [comment, setComment] = useState("");

  const reset = () => {
    setRating(0);
    setHoverRating(0);
    setReasons([]);
    setComment("");
  };

  const submitMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/rides/${rideId}/feedback`, {
        rating,
        reasons,
        comment: comment.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      toast.toast({ title: "Спасибо за отзыв!" });
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.toast({
        title: "Не удалось отправить отзыв",
        description: errorMessage(err, "Попробуйте ещё раз"),
        variant: "destructive",
      });
    },
  });

  const tier = rating > 0 ? feedbackTierForRating(rating) : null;

  const toggleReason = (id: string) => {
    setReasons((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !submitMut.isPending && handleOpenChange(v)}>
      <DialogContent data-testid="dialog-ride-feedback">
        <DialogHeader>
          <DialogTitle className="font-display font-light">Как прошла поездка?</DialogTitle>
        </DialogHeader>

        <div className="flex justify-center gap-1 py-2">
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = n <= (hoverRating || rating);
            return (
              <button
                key={n}
                type="button"
                onClick={() => setRating(n)}
                onMouseEnter={() => setHoverRating(n)}
                onMouseLeave={() => setHoverRating(0)}
                data-testid={`button-rating-star-${n}`}
                aria-label={`Оценка ${n} из 5`}
                className="p-1"
              >
                <Star
                  className={`w-8 h-8 transition-colors ${
                    filled ? "fill-primary text-primary" : "fill-none text-muted-foreground"
                  }`}
                />
              </button>
            );
          })}
        </div>

        {tier && (
          <div className="space-y-3">
            <div className="text-sm font-medium text-center">{FEEDBACK_TIER_TITLES[tier]}</div>
            <div className="flex flex-wrap justify-center gap-2">
              {FEEDBACK_REASONS[tier].map((opt) => {
                const active = reasons.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => toggleReason(opt.id)}
                    data-testid={`button-reason-${opt.id}`}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors hover-elevate ${
                      active ? "border-primary ring-1 ring-primary bg-primary/5" : "border-card-border"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {FEEDBACK_REASONS[tier].map((opt) => {
              if (!opt.subReasons || !reasons.includes(opt.id)) return null;
              return (
                <div key={opt.id} className="flex flex-wrap justify-center gap-2 pt-1">
                  {opt.subReasons.map((sub) => {
                    const subActive = reasons.includes(sub.id);
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => toggleReason(sub.id)}
                        data-testid={`button-reason-${sub.id}`}
                        className={`rounded-full border px-3 py-1.5 text-xs transition-colors hover-elevate ${
                          subActive ? "border-primary ring-1 ring-primary bg-primary/5" : "border-card-border"
                        }`}
                      >
                        {sub.label}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Комментарий (необязательно)"
              maxLength={500}
              data-testid="input-feedback-comment"
            />
          </div>
        )}

        <DialogFooter>
          {tier ? (
            <Button
              className="w-full"
              disabled={submitMut.isPending}
              onClick={() => submitMut.mutate()}
              data-testid="button-submit-feedback"
            >
              {submitMut.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Отправляем…
                </>
              ) : (
                "Отправить"
              )}
            </Button>
          ) : (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => handleOpenChange(false)}
              data-testid="button-skip-feedback"
            >
              Готово
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

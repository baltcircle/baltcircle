import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CURRENT_USER_KEY } from "@/hooks/use-current-user";
import type { User } from "@shared/schema";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { UserPlus } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Called after a successful registration so the caller can resume whatever
  // action the rider was attempting (e.g. open the rental modal).
  onRegistered?: (user: User) => void;
}

// Client-side mirror of the server validation so riders get instant feedback.
// The server re-validates and is the source of truth.
function validate(name: string, phone: string): string | null {
  if (name.trim().length < 2) return "Введите имя (минимум 2 символа)";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return "Введите корректный номер телефона";
  return null;
}

export function RegistrationModal({ open, onOpenChange, onRegistered }: Props) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const registerMut = useMutation<User, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/users/register", {
        name: name.trim(),
        phone: phone.trim(),
      });
      return res.json();
    },
    onSuccess: (user) => {
      queryClient.setQueryData(CURRENT_USER_KEY, user);
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });
      toast.toast({
        title: "Регистрация завершена",
        description: `Добро пожаловать, ${user.name}!`,
      });
      onOpenChange(false);
      onRegistered?.(user);
    },
    onError: (err) => {
      setError(err?.message?.replace(/^\d+:\s*/, "") ?? "Не удалось зарегистрироваться");
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = validate(name, phone);
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    registerMut.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-registration">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            <UserPlus className="w-5 h-5" /> Регистрация
          </DialogTitle>
          <DialogDescription>
            Укажите имя и номер телефона, чтобы арендовать велосипед. Данные карты
            не запрашиваются на этом шаге.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="registration-name">Имя</Label>
            <Input
              id="registration-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ваше имя"
              autoComplete="name"
              data-testid="input-registration-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="registration-phone">Номер телефона</Label>
            <Input
              id="registration-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 900 000-00-00"
              autoComplete="tel"
              data-testid="input-registration-phone"
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" data-testid="text-registration-error">
              {error}
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="button-registration-close"
            >
              Закрыть
            </Button>
            <Button
              type="submit"
              disabled={registerMut.isPending}
              data-testid="button-registration-submit"
            >
              {registerMut.isPending ? "Сохранение…" : "Зарегистрироваться"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

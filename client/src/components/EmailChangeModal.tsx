import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, errorMessage, queryClient } from "@/lib/queryClient";
import { CURRENT_USER_KEY } from "@/hooks/use-current-user";
import type { User } from "@shared/schema";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Mail, ShieldCheck, ArrowLeft } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type StartResponse = { email: string; resendInSec: number; devCode?: string };

// Mirror of PhoneChangeModal for the email verification flow. The user enters a
// target email, we send a code via RuSender, and only after the code is
// verified do we write the new email + mark it verified. Email is never
// changed through the profile PATCH endpoint.
export function EmailChangeModal({ open, onOpenChange }: Props) {
  const toast = useToast();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Normalized email the server is sending the code to — shown on the code step.
  const [targetEmail, setTargetEmail] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open) {
      setStep("email");
      setEmail("");
      setCode("");
      setError(null);
      setTargetEmail("");
      setResendIn(0);
    }
  }, [open]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (resendIn <= 0) return;
    timerRef.current = setInterval(() => {
      setResendIn((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resendIn > 0]);

  const startMut = useMutation<StartResponse, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/users/me/email/start", { email: email.trim() });
      return res.json();
    },
    onSuccess: (data) => {
      setTargetEmail(data.email);
      setResendIn(data.resendInSec ?? 60);
      setStep("code");
      setError(null);
      setCode("");
      if (data.devCode) {
        toast.toast({
          title: "Код подтверждения (dev)",
          description: `Email-провайдер не настроен. Код: ${data.devCode}`,
        });
      } else {
        toast.toast({ title: "Код отправлен", description: `Письмо с кодом отправлено на ${data.email}` });
      }
    },
    onError: (err) => {
      setError(errorMessage(err, "Не удалось отправить код"));
    },
  });

  const verifyMut = useMutation<User, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/users/me/email/verify", { code: code.trim() });
      return res.json();
    },
    onSuccess: (user) => {
      queryClient.setQueryData(CURRENT_USER_KEY, user);
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });
      toast.toast({ title: "Email подтверждён", description: `Новый email: ${user.email ?? ""}` });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(errorMessage(err, "Не удалось подтвердить код"));
    },
  });

  function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return setError("Введите корректный email");
    setError(null);
    startMut.mutate();
  }

  function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{4}$/.test(code.trim())) return setError("Код состоит из 4 цифр");
    setError(null);
    verifyMut.mutate();
  }

  function resend() {
    if (resendIn > 0 || startMut.isPending) return;
    setError(null);
    startMut.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-email-change">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            {step === "email" ? <Mail className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
            {step === "email" ? "Смена email" : "Подтверждение email"}
          </DialogTitle>
          <DialogDescription>
            {step === "email"
              ? "Укажите новый email. Мы отправим на него письмо с кодом подтверждения."
              : `Введите код из письма, отправленного на ${targetEmail}.`}
          </DialogDescription>
        </DialogHeader>

        {step === "email" ? (
          <form onSubmit={submitEmail} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email-change-input">Новый email</Label>
              <Input
                id="email-change-input"
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                data-testid="input-new-email"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-email-change-error">{error}</p>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-email-change-close">
                Закрыть
              </Button>
              <Button type="submit" disabled={startMut.isPending} data-testid="button-email-change-send">
                {startMut.isPending ? "Отправка…" : "Получить код"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email-change-code">Код из письма</Label>
              <Input
                id="email-change-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={4}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="1234"
                className="font-mono tracking-[0.5em] text-center text-lg"
                data-testid="input-email-change-code"
              />
            </div>

            <div className="text-xs text-muted-foreground">
              {resendIn > 0 ? (
                <span data-testid="text-email-change-resend-timer">Повторная отправка через {resendIn} с</span>
              ) : (
                <button
                  type="button"
                  onClick={resend}
                  disabled={startMut.isPending}
                  className="underline hover:text-foreground disabled:opacity-50"
                  data-testid="button-email-change-resend"
                >
                  {startMut.isPending ? "Отправка…" : "Отправить код повторно"}
                </button>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-email-change-error">{error}</p>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setStep("email"); setError(null); }}
                data-testid="button-email-change-back"
              >
                <ArrowLeft className="w-4 h-4 mr-1" /> Назад
              </Button>
              <Button type="submit" disabled={verifyMut.isPending || code.trim().length !== 4} data-testid="button-email-change-verify">
                {verifyMut.isPending ? "Проверка…" : "Подтвердить"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, errorMessage, queryClient } from "@/lib/queryClient";
import { CURRENT_USER_KEY } from "@/hooks/use-current-user";
import type { User } from "@shared/schema";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { isCompleteOtp, OTP_CODE_MESSAGE } from "@/lib/otp";
import { OtpCodeField } from "@/components/OtpCodeField";
import { ArrowLeft } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // "verify" — подтверждение уже указанной почты (её вводили при регистрации,
  // без подтверждения): адрес подставлен в поле, но остаётся редактируемым —
  // при регистрации могли ошибиться, и тогда код уйдёт на исправленный адрес,
  // а подтверждение заодно поменяет почту в профиле.
  mode?: "change" | "verify";
  currentEmail?: string | null;
}

type StartResponse = { email: string; resendInSec: number; devCode?: string };

// Mirror of PhoneChangeModal for the email verification flow. The user enters a
// target email, we send a code via RuSender, and only after the code is
// verified do we write the new email + mark it verified. Email is never
// changed through the profile PATCH endpoint.
export function EmailChangeModal({ open, onOpenChange, mode = "change", currentEmail }: Props) {
  const toast = useToast();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Normalized email the server is sending the code to — shown on the code step.
  const [targetEmail, setTargetEmail] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const verifyOnly = mode === "verify" && !!currentEmail;

  useEffect(() => {
    if (open) {
      setStep("email");
      setEmail(verifyOnly ? currentEmail! : "");
      setCode("");
      setError(null);
      setTargetEmail("");
      setResendIn(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, verifyOnly, currentEmail]);

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
      toast.toast({
        title: "Почта подтверждена",
        description: verifyOnly ? (user.email ?? "") : `Новый email: ${user.email ?? ""}`,
      });
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
    if (!isCompleteOtp(code)) return setError(OTP_CODE_MESSAGE);
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
      {/* Клик мимо карточки не закрывает окно: адрес или код обнулялись бы от
          случайного тапа. Остаются крестик, «Закрыть» и Escape. */}
      <DialogContent
        data-testid="dialog-email-change"
        className="rounded-2xl sm:rounded-2xl"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          {step === "email" ? (
            <>
              {/* Оба шага как в окне входа: одно поле, одна кнопка, всё нужное
                  сказано заголовком. Пояснение остаётся в DOM — Radix требует
                  его для aria-describedby. */}
              <DialogTitle className="font-display font-light text-center">
                {verifyOnly ? "Подтвердить почту" : "Сменить почту"}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {verifyOnly
                  ? "Отправим письмо с кодом на указанный адрес. Если при регистрации ошиблись — исправьте, почта поменяется вместе с подтверждением."
                  : "Укажите новый email. Мы отправим на него письмо с кодом подтверждения."}
              </DialogDescription>
            </>
          ) : (
            <>
              {/* Шаг кода оформлен как в окне входа: заголовок по центру,
                  пояснение скрыто, поле — кружки. Адрес письма уже показан на
                  предыдущем шаге, повторять его незачем. */}
              <DialogTitle className="font-display font-light text-center">Введите код</DialogTitle>
              <DialogDescription className="sr-only">
                {`Введите код из письма, отправленного на ${targetEmail}.`}
              </DialogDescription>
            </>
          )}
        </DialogHeader>

        {step === "email" ? (
          <form onSubmit={submitEmail} className="space-y-4">
            {/* Поле без рамки и по центру: оно на экране единственное. Размер
                меньше, чем у номера телефона, — адрес длиннее и с рамкой в
                одну строку не помещался бы. */}
            <div className="py-2">
              <input
                id="email-change-input"
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label={verifyOnly ? "Почта" : "Новый email"}
                autoComplete="email"
                autoFocus
                data-testid="input-new-email"
                className="w-full border-0 bg-transparent p-0 text-xl text-center outline-none focus:outline-none placeholder:text-muted-foreground/40"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-email-change-error">{error}</p>
            )}

            <DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2 sm:space-x-0">
              <Button type="submit" className="w-full" disabled={startMut.isPending} data-testid="button-email-change-send">
                {startMut.isPending ? "Отправка…" : "Получить код"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => onOpenChange(false)}
                data-testid="button-email-change-close"
              >
                Закрыть
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            <OtpCodeField
              id="email-change-code"
              value={code}
              onChange={setCode}
              label="Код из письма"
              autoFocus
              inputTestId="input-email-change-code"
              maskTestId="text-email-change-code-mask"
            />

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

            <DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2 sm:space-x-0">
              <Button
                type="submit"
                className="w-full"
                disabled={verifyMut.isPending || !isCompleteOtp(code)}
                data-testid="button-email-change-verify"
              >
                {verifyMut.isPending ? "Проверка…" : "Подтвердить"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => { setStep("email"); setError(null); }}
                data-testid="button-email-change-back"
              >
                <ArrowLeft className="w-4 h-4 mr-1" /> Назад
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

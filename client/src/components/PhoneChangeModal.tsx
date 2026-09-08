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
import { formatPhoneDigits, applyPhoneInput, normalizePhoneDigits } from "@/lib/phone";
import { ArrowLeft } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type StartResponse = { phone: string; resendInSec: number; devCode?: string };

// Change the logged-in rider's phone number. Mirrors the registration OTP flow
// but hits the phone-change endpoints, which verify a code sent to the NEW
// number before applying the change. Phone is never changed via profile PATCH.
export function PhoneChangeModal({ open, onOpenChange }: Props) {
  const toast = useToast();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phoneDigits, setPhoneDigits] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Normalized phone the server is sending the code to — shown on the code step.
  const [targetPhone, setTargetPhone] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open) {
      setStep("phone");
      setPhoneDigits("");
      setCode("");
      setError(null);
      setTargetPhone("");
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
      const res = await apiRequest("POST", "/api/users/me/phone/start", { phone: `+7${phoneDigits}` });
      return res.json();
    },
    onSuccess: (data) => {
      setTargetPhone(data.phone);
      setResendIn(data.resendInSec ?? 60);
      setStep("code");
      setError(null);
      setCode("");
      if (data.devCode) {
        toast.toast({
          title: "Код подтверждения (dev)",
          description: `SMS-провайдер не настроен. Код: ${data.devCode}`,
        });
      } else {
        toast.toast({ title: "Код отправлен", description: `SMS с кодом отправлено на ${data.phone}` });
      }
    },
    onError: (err) => {
      setError(errorMessage(err, "Не удалось отправить код"));
    },
  });

  const verifyMut = useMutation<User, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/users/me/phone/verify", { code: code.trim() });
      return res.json();
    },
    onSuccess: (user) => {
      queryClient.setQueryData(CURRENT_USER_KEY, user);
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });
      toast.toast({ title: "Номер изменён", description: `Новый номер: ${user.phone}` });
      onOpenChange(false);
    },
    onError: (err) => {
      setError(errorMessage(err, "Не удалось подтвердить код"));
    },
  });

  function submitPhone(e: React.FormEvent) {
    e.preventDefault();
    if (normalizePhoneDigits(phoneDigits).length < 10) return setError("Введите корректный номер телефона");
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
      {/* Клик мимо карточки не закрывает окно: набранный номер или код
          обнулялись бы от случайного тапа. Остаются крестик, «Закрыть» и Escape. */}
      <DialogContent
        data-testid="dialog-phone-change"
        className="rounded-2xl sm:rounded-2xl"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          {/* Как в окне входа: на каждом шаге одно поле и одна кнопка, всё
              нужное сказано заголовком, поэтому иконка и пояснение убраны.
              Описание остаётся в DOM — Radix требует его для aria-describedby. */}
          <DialogTitle className="font-display font-light text-center">
            {step === "phone" ? "Сменить номер телефона" : "Введите код"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {step === "phone"
              ? "Укажите новый номер телефона. Мы отправим SMS с кодом подтверждения на него."
              : `Введите код из SMS, отправленного на ${targetPhone}.`}
          </DialogDescription>
        </DialogHeader>

        {step === "phone" ? (
          <form onSubmit={submitPhone} className="space-y-4">
            <div className="flex items-center justify-center gap-0.5 py-2">
              <label htmlFor="phone-change-input" className="text-2xl text-muted-foreground select-none">
                +7
              </label>
              <input
                id="phone-change-input"
                type="tel"
                inputMode="numeric"
                value={formatPhoneDigits(phoneDigits)}
                onChange={(e) => setPhoneDigits(applyPhoneInput(e.target.value, phoneDigits))}
                placeholder="900 000-00-00"
                aria-label="Новый номер телефона"
                autoComplete="tel-national"
                autoFocus
                data-testid="input-new-phone"
                className="w-[13ch] border-0 bg-transparent p-0 text-2xl tabular-nums text-center outline-none focus:outline-none placeholder:text-muted-foreground/40"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-phone-change-error">{error}</p>
            )}

            <DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2 sm:space-x-0">
              <Button type="submit" className="w-full" disabled={startMut.isPending} data-testid="button-phone-change-send">
                {startMut.isPending ? "Отправка…" : "Получить код"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => onOpenChange(false)}
                data-testid="button-phone-change-close"
              >
                Закрыть
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            <OtpCodeField
              id="phone-change-code"
              value={code}
              onChange={setCode}
              label="Код из SMS"
              autoFocus
              inputTestId="input-phone-change-code"
              maskTestId="text-phone-change-code-mask"
            />

            <div className="text-xs text-muted-foreground">
              {resendIn > 0 ? (
                <span data-testid="text-phone-change-resend-timer">Повторная отправка через {resendIn} с</span>
              ) : (
                <button
                  type="button"
                  onClick={resend}
                  disabled={startMut.isPending}
                  className="underline hover:text-foreground disabled:opacity-50"
                  data-testid="button-phone-change-resend"
                >
                  {startMut.isPending ? "Отправка…" : "Отправить код повторно"}
                </button>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-phone-change-error">{error}</p>
            )}

            <DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2 sm:space-x-0">
              <Button
                type="submit"
                className="w-full"
                disabled={verifyMut.isPending || !isCompleteOtp(code)}
                data-testid="button-phone-change-verify"
              >
                {verifyMut.isPending ? "Проверка…" : "Подтвердить"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => { setStep("phone"); setError(null); }}
                data-testid="button-phone-change-back"
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

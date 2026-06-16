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
import { Smartphone, ShieldCheck, ArrowLeft } from "lucide-react";

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
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Normalized phone the server is sending the code to — shown on the code step.
  const [targetPhone, setTargetPhone] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open) {
      setStep("phone");
      setPhone("");
      setCode("");
      setError(null);
      setTargetPhone("");
      setResendIn(0);
    }
  }, [open]);

  useEffect(() => {
    if (resendIn <= 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setResendIn((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [resendIn]);

  const startMut = useMutation<StartResponse, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/users/me/phone/start", { phone: phone.trim() });
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
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) return setError("Введите корректный номер телефона");
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
      <DialogContent data-testid="dialog-phone-change">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            {step === "phone" ? <Smartphone className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
            {step === "phone" ? "Смена номера телефона" : "Подтверждение номера"}
          </DialogTitle>
          <DialogDescription>
            {step === "phone"
              ? "Укажите новый номер телефона. Мы отправим SMS с кодом подтверждения на него."
              : `Введите код из SMS, отправленного на ${targetPhone}.`}
          </DialogDescription>
        </DialogHeader>

        {step === "phone" ? (
          <form onSubmit={submitPhone} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="phone-change-input">Новый номер телефона</Label>
              <Input
                id="phone-change-input"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+7 900 000-00-00"
                autoComplete="tel"
                data-testid="input-new-phone"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-phone-change-error">{error}</p>
            )}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-phone-change-close">
                Закрыть
              </Button>
              <Button type="submit" disabled={startMut.isPending} data-testid="button-phone-change-send">
                {startMut.isPending ? "Отправка…" : "Получить код"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="phone-change-code">Код из SMS</Label>
              <Input
                id="phone-change-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={4}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="1234"
                className="font-mono tracking-[0.5em] text-center text-lg"
                data-testid="input-phone-change-code"
              />
            </div>

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

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setStep("phone"); setError(null); }}
                data-testid="button-phone-change-back"
              >
                <ArrowLeft className="w-4 h-4 mr-1" /> Назад
              </Button>
              <Button type="submit" disabled={verifyMut.isPending || code.trim().length !== 4} data-testid="button-phone-change-verify">
                {verifyMut.isPending ? "Проверка…" : "Подтвердить"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

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
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, ShieldCheck, ArrowLeft } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Called after a successful verification so the caller can resume whatever
  // action the rider was attempting (e.g. open the rental modal).
  onRegistered?: (user: User) => void;
}

type StartResponse = { phone: string; resendInSec: number; devCode?: string; providerStatus?: string };

// Client-side mirror of the server validation so riders get instant feedback.
// The server re-validates and is the source of truth.
function validateContact(name: string, phone: string): string | null {
  if (name.trim().length < 2) return "Введите имя (минимум 2 символа)";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return "Введите корректный номер телефона";
  return null;
}

export function RegistrationModal({ open, onOpenChange, onRegistered }: Props) {
  const toast = useToast();
  const [step, setStep] = useState<"contact" | "code">("contact");
  const [name, setName] = useState("");
  // Phone digits only (without +7 prefix — we prepend it on submit)
  const [phoneDigits, setPhoneDigits] = useState("");
  const phone = phoneDigits ? "+7" + phoneDigits : "";
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Normalized phone returned by the server's start step — used verbatim for
  // verify and resend so both sides agree on the canonical number.
  const [verifiedPhone, setVerifiedPhone] = useState("");
  // Provider delivery status returned by the start step (e.g. "queued"), shown
  // subtly so the rider knows the SMS was accepted. Absent in dev fallback.
  const [providerStatus, setProviderStatus] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset everything whenever the modal opens.
  useEffect(() => {
    if (open) {
      setStep("contact");
      setName("");
      setPhoneDigits("");
      setConsent(false);
      setCode("");
      setError(null);
      setVerifiedPhone("");
      setProviderStatus(null);
      setResendIn(0);
    }
  }, [open]);

  // Resend countdown ticker.
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
      const res = await apiRequest("POST", "/api/auth/otp/start", {
        name: name.trim(),
        phone: phone.trim(),
        consent,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setVerifiedPhone(data.phone);
      setProviderStatus(data.providerStatus ?? null);
      setResendIn(data.resendInSec ?? 60);
      setStep("code");
      setError(null);
      setCode("");
      if (data.devCode) {
        // Dev fallback only: server has no SMS provider configured, so it echoes
        // the code to make local testing possible.
        toast.toast({
          title: "Код подтверждения (dev)",
          description: `SMS-провайдер не настроен. Код: ${data.devCode}`,
        });
      } else {
        toast.toast({
          title: "Код отправлен",
          description: `SMS с кодом отправлено на ${data.phone}`,
        });
      }
    },
    onError: (err) => {
      setError(errorMessage(err, "Не удалось отправить код"));
      // Keep resendIn if server set a cooldown (e.g. duplicate sending),
      // but don't reset it — let the existing countdown keep running.
    },
  });

  const verifyMut = useMutation<User, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/otp/verify", {
        phone: verifiedPhone,
        code: code.trim(),
      });
      return res.json();
    },
    onSuccess: (user) => {
      queryClient.setQueryData(CURRENT_USER_KEY, user);
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_KEY });
      toast.toast({
        title: "Номер подтверждён",
        description: `Добро пожаловать, ${user.name}!`,
      });
      onOpenChange(false);
      onRegistered?.(user);
    },
    onError: (err) => {
      setError(errorMessage(err, "Не удалось подтвердить код"));
    },
  });

  function submitContact(e: React.FormEvent) {
    e.preventDefault();
    const v = validateContact(name, phone);
    if (v) return setError(v);
    if (!consent) return setError("Необходимо согласие на обработку персональных данных");
    setError(null);
    startMut.mutate();
  }

  function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) return setError("Код состоит из 6 цифр");
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
      <DialogContent data-testid="dialog-registration">
        <DialogHeader>
          <DialogTitle className="font-display font-light flex items-center gap-2">
            {step === "contact" ? <UserPlus className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
            {step === "contact" ? "Регистрация" : "Подтверждение номера"}
          </DialogTitle>
          <DialogDescription>
            {step === "contact"
              ? "Укажите имя и номер телефона. Мы отправим SMS с кодом подтверждения. Данные карты не запрашиваются."
              : `Введите код из SMS, отправленного на ${verifiedPhone}.`}
          </DialogDescription>
        </DialogHeader>

        {step === "contact" ? (
          <form onSubmit={submitContact} className="space-y-4">
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
              <div className="flex items-center border rounded-md overflow-hidden focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0">
                <span className="px-3 py-2 bg-muted text-muted-foreground text-sm select-none border-r">+7</span>
                <input
                  id="registration-phone"
                  type="tel"
                  inputMode="numeric"
                  value={phoneDigits}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
                    setPhoneDigits(digits);
                  }}
                  placeholder="900 000-00-00"
                  autoComplete="tel-national"
                  data-testid="input-registration-phone"
                  className="flex-1 px-3 py-2 text-sm bg-background outline-none"
                />
              </div>
            </div>

            <div className="flex items-start gap-2.5">
              <Checkbox
                id="consent"
                checked={consent}
                onCheckedChange={(v) => setConsent(v === true)}
                className="mt-0.5"
                data-testid="checkbox-personal-data-consent"
              />
              <Label htmlFor="consent" className="text-xs font-normal leading-snug text-muted-foreground">
                Я согласен на обработку персональных данных и принимаю{" "}
                <a
                  href="/legal/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                  data-testid="link-privacy"
                >
                  Политику конфиденциальности
                </a>{" "}
                и{" "}
                <a
                  href="/legal/consent"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                  data-testid="link-consent"
                >
                  Согласие на обработку данных
                </a>
                .
              </Label>
            </div>

            {error && (
              <p className="text-sm text-destructive" data-testid="text-registration-error">
                {error}
              </p>
            )}

            {resendIn > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="text-resend-cooldown">
                Повторная отправка будет доступна через{" "}
                <span className="tabular-nums font-medium">{resendIn}</span> с
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
                disabled={startMut.isPending || !consent || resendIn > 0}
                data-testid="button-send-otp"
              >
                {startMut.isPending ? "Отправка…" : resendIn > 0 ? `Подождите ${resendIn} с` : "Получить код"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="registration-code">Код из SMS</Label>
              <Input
                id="registration-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                className="font-mono tracking-[0.5em] text-center text-lg"
                data-testid="input-registration-code"
              />
            </div>

            {providerStatus && (
              <p className="text-xs text-muted-foreground" data-testid="text-sms-status">
                SMS отправлено, статус: {providerStatus}
              </p>
            )}

            <div className="text-xs text-muted-foreground">
              {resendIn > 0 ? (
                <span data-testid="text-resend-timer">
                  Повторная отправка через {resendIn} с
                </span>
              ) : (
                <button
                  type="button"
                  onClick={resend}
                  disabled={startMut.isPending}
                  className="underline hover:text-foreground disabled:opacity-50"
                  data-testid="button-resend-otp"
                >
                  {startMut.isPending ? "Отправка…" : "Отправить код повторно"}
                </button>
              )}
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
                onClick={() => {
                  setStep("contact");
                  setError(null);
                }}
                data-testid="button-registration-back"
              >
                <ArrowLeft className="w-4 h-4 mr-1" /> Назад
              </Button>
              <Button
                type="submit"
                disabled={verifyMut.isPending || code.trim().length !== 4}
                data-testid="button-verify-otp"
              >
                {verifyMut.isPending ? "Проверка…" : "Подтвердить"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

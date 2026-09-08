import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { sanitizeOtpInput, OTP_CODE_LENGTH } from "@/lib/otp";

interface Props {
  id: string;
  value: string;
  onChange: (code: string) => void;
  label: string;
  autoFocus?: boolean;
  inputTestId: string;
  maskTestId: string;
}

// Поле ввода одноразового кода: кружки по числу цифр, полые до ввода и залитые
// по мере набора. Само поле лежит прозрачным слоем поверх них — так остаётся
// один настоящий input с autoComplete="one-time-code" (автоподстановка кода
// работает только на текстовом поле, поэтому не type="password"), а тап в
// любое место области фокусирует его. Цифры скрыты цветом, а не
// -webkit-text-security: на устройствах оно не срабатывает.
export function OtpCodeField({ id, value, onChange, label, autoFocus, inputTestId, maskTestId }: Props) {
  return (
    <div className="relative flex items-center justify-center py-4">
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={OTP_CODE_LENGTH}
        value={value}
        onChange={(e) => onChange(sanitizeOtpInput(e.target.value))}
        aria-label={label}
        autoFocus={autoFocus}
        className="otp-masked absolute inset-0 h-full w-full border-0 bg-transparent p-0 text-center text-2xl shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        data-testid={inputTestId}
      />
      <div aria-hidden="true" className="pointer-events-none flex items-center gap-5" data-testid={maskTestId}>
        {Array.from({ length: OTP_CODE_LENGTH }, (_, i) => (
          <span
            key={i}
            className={cn(
              "h-3.5 w-3.5 rounded-full border-2 transition-colors",
              i < value.length
                ? "border-foreground bg-foreground"
                : "border-muted-foreground/50 bg-transparent",
            )}
          />
        ))}
      </div>
    </div>
  );
}
